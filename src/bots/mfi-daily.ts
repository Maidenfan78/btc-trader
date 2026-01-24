/**
 * MFI Daily Bot - Multi-Asset Daily Timeframe
 *
 * Trades on daily timeframe using MFI crossover signals.
 * Two-leg position management: TP leg + Runner leg with trailing stop.
 * Now supports multiple assets via bots.json configuration.
 */

import * as fs from 'fs';
import {
  BinanceFetcher,
  calculateMFISeries,
  calculateATRSeries,
  generateSignal,
  isValidSignal,
  updatePositions,
  initializeMultiAssetState,
  getAssetPositions,
  updateAssetPositions,
  canAssetTrade,
  recordAssetTrade,
  getMultiAssetSummary,
  getTotalOpenPositions,
  getTotalCapitalPerSignal,
  PaperBroker,
  LiveBroker,
  CircuitBreaker,
  getAllBalances,
  getBalanceSummary,
  createLogger,
  createTradingCSVLogger,
  MultiAssetBotState,
  AssetSignal,
  AssetConfig,
  MultiAssetManagerConfig,
  Logger,
  EventStore,
  JournalEmitter,
} from 'trading-bot-platform';
import { loadMFIDailyConfig } from '../config/mfi-daily.js';
import { getAllAssets, getAssetsBySymbols } from '../config/assets.js';
import { getBotEnabledAssets } from '../config/bots.js';
import { hydrateMultiAssetState } from '../config/state.js';

const BOT_ID = 'btc-daily';
const INDICATOR_NAME = 'MFI';
const STATE_FILE = process.env.BOT_STATE_FILE || 'state.json';

let logger: Logger;
let currentState: MultiAssetBotState | null = null;

function getLogger(): Logger {
  if (!logger) {
    const logFile = process.env.BOT_LOG_FILE || 'logs/bot-btc-daily.log';
    const errorFile = process.env.BOT_ERROR_LOG_FILE || 'logs/error-btc-daily.log';
    logger = createLogger({
      botId: BOT_ID,
      logDir: 'logs',
      logLevel: 'info',
      logFile,
      errorLogFile: errorFile,
    });
  }
  return logger;
}

// Graceful shutdown handlers
function setupShutdownHandlers(): void {
  const log = getLogger();

  const shutdown = (signal: string) => {
    log.info(`Received ${signal}, saving state before exit...`);
    if (currentState) {
      try {
        const stateWithSnapshot = {
          ...currentState,
          indicatorSnapshot,
        };
        fs.writeFileSync(STATE_FILE, JSON.stringify(stateWithSnapshot, null, 2));
        log.info('State saved successfully');
      } catch (err) {
        log.error('Failed to save state on shutdown:', err);
      }
    }
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// Indicator snapshot for dashboard display
interface IndicatorSnapshot {
  [asset: string]: {
    price: number;
    indicator: number;
    atr: number;
    trend: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
    updatedAt: number;
  };
}

let indicatorSnapshot: IndicatorSnapshot = {};

// Initialize event store and journal emitter
const dataDir = process.env.BOT_DATA_DIR || 'data';
if (!fs.existsSync(dataDir)) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
  } catch (err) {
    const log = getLogger();
    log.error(`Failed to create data directory: ${dataDir}`, err);
    throw new Error(`Cannot create data directory: ${dataDir}`);
  }
}

const eventStore = new EventStore({ dataDir });

function createJournalEmitter(config: ReturnType<typeof loadMFIDailyConfig>): JournalEmitter {
  return new JournalEmitter({
    botId: BOT_ID,
    mode: config.paperMode ? 'PAPER' : 'LIVE',
    eventStore,
  });
}

function loadState(assets: AssetConfig[]): MultiAssetBotState {
  const log = getLogger();
  if (fs.existsSync(STATE_FILE)) {
    try {
      const data = fs.readFileSync(STATE_FILE, 'utf-8');
      const state = JSON.parse(data);
      log.info('Loaded existing daily bot state from disk');
      return hydrateMultiAssetState(assets, state);
    } catch {
      log.warn('Failed to load state file, initializing fresh state');
      return initializeMultiAssetState(assets);
    }
  }
  log.info('No existing state found, initializing fresh state');
  return initializeMultiAssetState(assets);
}

function saveState(state: MultiAssetBotState): void {
  const log = getLogger();
  try {
    const stateWithSnapshot = {
      ...state,
      indicatorSnapshot,
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(stateWithSnapshot, null, 2));
    log.info('State saved to disk');
  } catch (error) {
    log.error('Failed to save state:', error);
  }
}

async function fetchCandlesWithRetry(
  fetcher: BinanceFetcher,
  limit: number,
  log: Logger,
  assetSymbol: string,
  intervalLabel: string
): Promise<Awaited<ReturnType<BinanceFetcher['fetchCandles']>>> {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fetcher.fetchCandles(limit);
    } catch (err) {
      log.warn(`${assetSymbol}: Failed to fetch ${intervalLabel} candles (attempt ${attempt}/${maxAttempts})`, err);
      if (attempt === maxAttempts) {
        throw err;
      }
      const backoffMs = 1000 * Math.pow(2, attempt - 1);
      await new Promise(resolve => setTimeout(resolve, backoffMs));
    }
  }

  return [];
}

/**
 * Process a single asset
 */
async function processAsset(
  asset: AssetConfig,
  state: MultiAssetBotState,
  config: ReturnType<typeof loadMFIDailyConfig>,
  broker: PaperBroker | LiveBroker,
  csvLogger: ReturnType<typeof createTradingCSVLogger>,
  circuitBreaker: CircuitBreaker,
  journal: JournalEmitter
): Promise<AssetSignal | null> {
  const log = getLogger();

  log.info(`\n${'='.repeat(60)}`);
  log.info(`Processing: ${asset.symbol} (${asset.name})`);
  log.info('='.repeat(60));

  // Fetch candles
  const fetcher = new BinanceFetcher({ symbol: asset.binanceSymbol, interval: '1d' });
  const numCandles = Math.max(config.mfiPeriod, config.atrPeriod) * 2;
  const candles = await fetchCandlesWithRetry(fetcher, numCandles, log, asset.symbol, '1D');
  log.info(`Fetched ${candles.length} daily candles for ${asset.symbol}`);

  const latestCandle = candles[candles.length - 1];

  // Calculate indicators
  const mfiSeries = calculateMFISeries(candles, config.mfiPeriod);
  const atrSeries = calculateATRSeries(candles, config.atrPeriod);

  const currentMFI = mfiSeries[mfiSeries.length - 1];
  const previousMFI = mfiSeries[mfiSeries.length - 2];
  const currentATR = atrSeries[atrSeries.length - 1];

  if (currentMFI === null || previousMFI === null || currentATR === null) {
    log.warn(`${asset.symbol}: Insufficient indicator data, skipping`);
    return null;
  }

  log.info(`${asset.symbol} - Price: $${latestCandle.close.toFixed(2)}, MFI: ${currentMFI.toFixed(2)}, ATR: $${currentATR.toFixed(2)}`);

  const marketContext = JournalEmitter.createMarketContext({
    price: latestCandle.close,
    indicator: currentMFI,
    indicatorName: INDICATOR_NAME,
    atr: currentATR,
    candleTime: latestCandle.timestamp,
    buyLevel: config.mfiBuyLevel,
    sellLevel: config.mfiSellLevel,
  });

  // Update indicator snapshot for dashboard
  const trend = currentMFI <= config.mfiBuyLevel ? 'BULLISH' :
                currentMFI >= config.mfiSellLevel ? 'BEARISH' : 'NEUTRAL';
  indicatorSnapshot[asset.symbol] = {
    price: latestCandle.close,
    indicator: currentMFI,
    atr: currentATR,
    trend,
    updatedAt: Date.now(),
  };

  // Update existing positions
  const assetPos = getAssetPositions(state, asset.symbol);
  if (!assetPos) {
    log.error(`${asset.symbol}: Asset not found in state`);
    return null;
  }

  if (assetPos.openLegs.length > 0) {
    log.info(`${asset.symbol}: Updating ${assetPos.openLegs.length} open positions...`);

    const updatedLegs = updatePositions(assetPos.openLegs, latestCandle.close, currentATR);

    // Log closed legs
    const closedLegs = updatedLegs.filter(l =>
      l.status === 'CLOSED' && !assetPos.openLegs.find(ol => ol.id === l.id && ol.status === 'CLOSED')
    );
    if (closedLegs.length > 0) {
      for (const leg of closedLegs) {
        log.info(`${asset.symbol}: ${leg.type} leg closed - ${leg.closeReason}`);
        try {
          await broker.closeLeg(leg, latestCandle, leg.closeReason || 'Unknown');
          csvLogger.logPositionLegClosure(leg, asset.symbol, config.paperMode ? 'PAPER' : 'LIVE');
        } catch (err) {
          log.error(`${asset.symbol}: Failed to close ${leg.type} leg ${leg.id}`, err);
        }
      }
    }

    updateAssetPositions(state, asset.symbol, updatedLegs);
  }

  // Generate signal
  const signal = generateSignal(
    previousMFI,
    currentMFI,
    latestCandle.close,
    currentATR,
    latestCandle.timestamp,
    config.mfiBuyLevel,
    config.mfiSellLevel
  );

  if (isValidSignal(signal)) {
    log.info(`${asset.symbol}: Signal detected - ${signal.type}, MFI ${previousMFI.toFixed(2)} -> ${currentMFI.toFixed(2)}`);

    const signalType = signal.type === 'LONG' ? 'LONG' : 'SHORT';
    journal.signalGenerated(asset.symbol, marketContext, {
      signalType,
      previousIndicator: previousMFI,
      currentIndicator: currentMFI,
      buyLevel: config.mfiBuyLevel,
      sellLevel: config.mfiSellLevel,
      crossDirection: signalType === 'LONG' ? 'UP' : 'DOWN',
    });

    return {
      type: signal.type,
      asset: asset.symbol,
      price: latestCandle.close,
      mfi: currentMFI,
      atr: currentATR,
      timestamp: latestCandle.timestamp,
    };
  }

  journal.noSignal(asset.symbol, marketContext, {
    indicatorValue: currentMFI,
    buyLevel: config.mfiBuyLevel,
    sellLevel: config.mfiSellLevel,
    reason: 'No crossover',
  });

  log.info(`${asset.symbol}: No signal (MFI: ${currentMFI.toFixed(2)})`);
  return null;
}

/**
 * Core bot execution logic
 */
async function runBotCycle() {
  const log = getLogger();

  try {
    log.info('=== MFI Daily Bot Starting ===');
    log.info(`Timestamp: ${new Date().toISOString()}`);

    // Load config
    const config = loadMFIDailyConfig();
    const cycleStartTime = Date.now();
    const journal = createJournalEmitter(config);
    journal.startCycle();
    log.info(`Mode: ${config.paperMode ? 'PAPER' : 'LIVE'}`);
    log.info(`Trading: ${config.liveTradingEnabled ? 'ENABLED' : 'DISABLED'}`);

    if (!config.paperMode && !config.liveTradingEnabled) {
      log.warn('Live mode but trading disabled - will analyze only');
    }

    // Load assets from bots.json
    const allAssets = getAllAssets();
    const enabledSymbols = getBotEnabledAssets(BOT_ID);
    const assets = getAssetsBySymbols(enabledSymbols);

    if (assets.length === 0) {
      log.error('No enabled assets found for this bot - exiting');
      process.exit(1);
    }

    log.info(`Trading ${assets.length} asset(s): ${assets.map(a => a.symbol).join(', ')}`);

    // Load state
    const state = loadState(allAssets);
    currentState = state;
    log.info('State loaded', {
      totalOpenPositions: getTotalOpenPositions(state),
    });

    const cycleStartMarket = JournalEmitter.createMarketContext({
      price: 0,
      indicator: 0,
      indicatorName: INDICATOR_NAME,
      atr: 0,
      candleTime: Date.now(),
      buyLevel: config.mfiBuyLevel,
      sellLevel: config.mfiSellLevel,
    });

    journal.cycleStart(cycleStartMarket, {
      assetsToProcess: assets.map(a => a.symbol),
      totalOpenPositions: getTotalOpenPositions(state),
    });

    // Create multi-asset manager config
    const managerConfig: MultiAssetManagerConfig = {
      assets: allAssets,
      maxPositionsPerAsset: 2,
      maxTotalPositions: 6,
      minTimeBetweenTradesMs: 24 * 60 * 60 * 1000, // 24 hours
    };

    // Initialize circuit breaker
    const circuitBreaker = new CircuitBreaker({
      maxDailyLossPct: 5.0,
      maxConsecutiveLosses: 3,
      maxDailyTrades: config.maxTradesPerDay,
      minTimeBetweenTradesMs: 24 * 60 * 60 * 1000,
      maxPriceDeviationPct: 10.0,
    });

    log.info(circuitBreaker.getSummary());

    // Initialize CSV logger
    const csvDir = process.env.BOT_CSV_DIR || 'logs/csv/btc-daily';
    const csvLogger = createTradingCSVLogger({ csvDir });

    // Initialize broker
    let broker: PaperBroker | LiveBroker;

    if (config.paperMode) {
      broker = new PaperBroker({
        initialUsdcBalance: 10000,
        initialBtcBalance: 0,
        slippageBps: config.slippageBps,
        tradeLegUsdc: config.tradeLegUsdc,
      });
      log.info('Paper broker initialized');
    } else {
      broker = new LiveBroker({
        rpcUrl: config.solanaRpcUrl,
        walletSecretKey: config.walletSecretKey,
        usdcMint: config.usdcMint,
        cbBtcMint: config.cbBtcMint || '',
        wbtcMint: config.wbtcMint,
        slippageBps: config.slippageBps,
        maxPriceImpactBps: config.maxPriceImpactBps,
        tradeLegUsdc: config.tradeLegUsdc,
        atrTpMultiplier: config.atrTpMult,
        atrTrailMultiplier: config.atrTrailMult,
        minBtcBalance: config.minBtcBalance,
        minUsdcReserve: config.minUsdcReserve,
      });
      log.info('Live broker initialized');

      // Show balances
      const walletPublicKey = (broker as LiveBroker).getWalletPublicKey();
      const connection = (broker as LiveBroker).getConnection();

      const balances = await getAllBalances(
        connection,
        walletPublicKey,
        config.usdcMint,
        config.cbBtcMint || '',
        config.wbtcMint
      );

      if (balances.usdc < config.minUsdcReserve) {
        log.error(`Insufficient USDC balance: ${balances.usdc.toFixed(2)} USDC (minimum reserve: ${config.minUsdcReserve})`);
        process.exit(1);
      }

      // Get current price for balance summary
      const firstAsset = assets[0];
      const fetcher = new BinanceFetcher({ symbol: firstAsset.binanceSymbol, interval: '1d' });
      const recentCandles = await fetchCandlesWithRetry(fetcher, 1, log, firstAsset.symbol, '1D');
      const currentPrice = recentCandles[0].close;

      log.info(getBalanceSummary(balances.usdc, balances.totalBtc, currentPrice));
    }

    // Show current position summary
    log.info(getMultiAssetSummary(state));
    log.info(`Total capital per full signal: $${getTotalCapitalPerSignal(allAssets)}`);

    // Track cycle metrics
    let positionsOpened = 0;
    let positionsClosed = 0;
    let runnersTrimmed = 0;

    // Process each asset
    const signals: AssetSignal[] = [];
    for (const asset of assets) {
      try {
        const signal = await processAsset(asset, state, config, broker, csvLogger, circuitBreaker, journal);
        if (signal) {
          signals.push(signal);
        }
      } catch (error) {
        log.error(`Error processing ${asset.symbol}:`, error);
        journal.error(asset.symbol, cycleStartMarket, {
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          context: 'processAsset',
        });
      }
    }

    // Handle signals
    log.info(`\n${'='.repeat(80)}`);
    log.info('SIGNAL PROCESSING');
    log.info('='.repeat(80));

    if (signals.length === 0) {
      log.info('No signals generated across all assets');
    } else {
      log.info(`Generated ${signals.length} signal(s):`);
      for (const signal of signals) {
        log.info(`  ${signal.asset}: ${signal.type} at $${signal.price.toFixed(2)} (MFI: ${signal.mfi.toFixed(2)})`);
      }

      // Process LONG signals
      const longSignals = signals.filter(s => s.type === 'LONG');
      for (const signal of longSignals) {
        const asset = assets.find(a => a.symbol === signal.asset);
        if (!asset) continue;

        // Check circuit breaker
        const canTradeCheck = circuitBreaker.canTrade();
        if (!canTradeCheck.allowed) {
          log.warn(`${signal.asset}: Trade blocked by circuit breaker - ${canTradeCheck.reason}`);
          continue;
        }

        // Check if we can trade this asset
        const tradeCheck = canAssetTrade(
          state,
          signal.asset,
          managerConfig,
          signal.timestamp
        );

        if (!tradeCheck.canTrade) {
          log.info(`${signal.asset}: LONG signal filtered - ${tradeCheck.reason}`);
          const rejectMarket = JournalEmitter.createMarketContext({
            price: signal.price,
            indicator: signal.mfi,
            indicatorName: INDICATOR_NAME,
            atr: signal.atr,
            candleTime: signal.timestamp,
            buyLevel: config.mfiBuyLevel,
            sellLevel: config.mfiSellLevel,
          });
          journal.signalRejected(signal.asset, rejectMarket, {
            signalType: 'LONG',
            reason: tradeCheck.reason || 'Trade filtered',
          });
          continue;
        }

        if (!config.liveTradingEnabled && !config.paperMode) {
          log.info(`${signal.asset}: LONG signal - trading disabled, skipping`);
          continue;
        }

        // Open position
        log.info(`${signal.asset}: Opening two-leg position...`);

        const brokerSignal = {
          type: 'LONG' as const,
          entryPrice: signal.price,
          targetPrice: signal.price + signal.atr * config.atrTpMult,
          atr: signal.atr,
          timestamp: signal.timestamp,
          mfi: signal.mfi,
          price: signal.price,
        };

        const candle = {
          timestamp: signal.timestamp,
          open: signal.price,
          high: signal.price,
          low: signal.price,
          close: signal.price,
          volume: 0,
        };

        const newLegs = await broker.openPosition(brokerSignal, candle);

        if (newLegs) {
          const assetPos = getAssetPositions(state, signal.asset);
          if (assetPos) {
            assetPos.openLegs = [...assetPos.openLegs, ...newLegs];
            recordAssetTrade(state, signal.asset, signal.timestamp);
            log.info(`${signal.asset}: Position opened successfully`);
            positionsOpened++;

            // Log to CSV
            const totalUSDC = newLegs.reduce((sum, leg) => sum + (leg.entryPrice * leg.quantity), 0);
            const totalQty = newLegs.reduce((sum, leg) => sum + leg.quantity, 0);

            csvLogger.logTradeEntry({
              date: new Date(signal.timestamp).toISOString(),
              timestamp: signal.timestamp,
              asset: signal.asset,
              action: 'OPEN',
              signalType: 'LONG',
              mfi: signal.mfi,
              atr: signal.atr,
              price: signal.price,
              totalUSDC,
              totalQuantity: totalQty,
              legsOpened: newLegs.length,
              targetPrice: newLegs[0].targetPrice || 0,
              trailingStop: newLegs[0].trailingStop || 0,
              mode: config.paperMode ? 'PAPER' : 'LIVE',
            });
          }
        } else {
          log.error(`${signal.asset}: Failed to open position`);
          const failMarket = JournalEmitter.createMarketContext({
            price: signal.price,
            indicator: signal.mfi,
            indicatorName: INDICATOR_NAME,
            atr: signal.atr,
            candleTime: signal.timestamp,
            buyLevel: config.mfiBuyLevel,
            sellLevel: config.mfiSellLevel,
          });
          journal.tradeFailed(signal.asset, failMarket, {
            signalType: 'LONG',
            reason: 'Failed to open position',
          });
        }
      }

      // Process SHORT signals (trim runners)
      const shortSignals = signals.filter(s => s.type === 'SHORT');
      for (const signal of shortSignals) {
        const assetPos = getAssetPositions(state, signal.asset);
        if (!assetPos) continue;

        const runnersBefore = assetPos.openLegs.filter(l => l.type === 'RUNNER' && l.status === 'OPEN').length;

        if (runnersBefore > 0) {
          log.info(`${signal.asset}: SHORT signal - trimming ${runnersBefore} runner(s)`);

          const brokerSignal = {
            type: 'SHORT' as const,
            entryPrice: signal.price,
            targetPrice: 0,
            atr: signal.atr,
            timestamp: signal.timestamp,
            mfi: signal.mfi,
            price: signal.price,
          };

          const candle = {
            timestamp: signal.timestamp,
            open: signal.price,
            high: signal.price,
            low: signal.price,
            close: signal.price,
            volume: 0,
          };

          const updatedLegs = await broker.trimRunners(assetPos.openLegs, brokerSignal, candle);

          // Log trimmed runners
          const trimmedRunners = updatedLegs.filter(
            leg => leg.type === 'RUNNER' && leg.status === 'CLOSED' && leg.closeTime === signal.timestamp
          );
          csvLogger.logPositionLegClosures(trimmedRunners, signal.asset, config.paperMode ? 'PAPER' : 'LIVE');
          runnersTrimmed += trimmedRunners.length;

          updateAssetPositions(state, signal.asset, updatedLegs);

          const runnersAfter = updatedLegs.filter(l => l.type === 'RUNNER' && l.status === 'OPEN').length;
          log.info(`${signal.asset}: Trimmed ${runnersBefore - runnersAfter} runner(s)`);
        }
      }
    }

    // Save state
    state.lastProcessedCandleTime = Date.now();
    saveState(state);
    log.info('State saved');

    const cycleEndMarket = JournalEmitter.createMarketContext({
      price: 0,
      indicator: 0,
      indicatorName: INDICATOR_NAME,
      atr: 0,
      candleTime: Date.now(),
      buyLevel: config.mfiBuyLevel,
      sellLevel: config.mfiSellLevel,
    });

    journal.cycleEnd(cycleEndMarket, {
      assetsProcessed: assets.length,
      signalsGenerated: signals.length,
      positionsOpened,
      positionsClosed,
      runnersTrimmed,
      cycleDurationMs: Date.now() - cycleStartTime,
    });
    journal.endCycle();

    // Final summary
    log.info(circuitBreaker.getSummary());
    log.info(getMultiAssetSummary(state));
    log.info('=== Bot Run Complete ===');

  } catch (error: any) {
    log.error('Fatal error:', error.message);
    log.error(error.stack);
    process.exit(1);
  }
}

/**
 * Main entry point
 */
async function main() {
  const log = getLogger();
  setupShutdownHandlers();
  const config = loadMFIDailyConfig();

  if (config.continuousMode) {
    log.info('CONTINUOUS MODE ENABLED');
    log.info('Bot will run 24/7, executing after new candles form');

    // Import continuous mode handler
    const { startContinuousMode } = await import('../continuous/daily.js');
    await startContinuousMode(
      config,
      () => {
        const allAssets = getAllAssets();
        const state = loadState(allAssets);
        return state.lastProcessedCandleTime;
      },
      runBotCycle
    );
  } else {
    await runBotCycle();
  }
}

// Run if called directly
if (require.main === module) {
  main().catch((error) => {
    console.error('Fatal error in main:', error);
    process.exit(1);
  });
}

export { main, runBotCycle };
