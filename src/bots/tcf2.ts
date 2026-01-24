/**
 * TCF2 (Trend Continuation Factor 2) Multi-Asset Trading Bot
 *
 * Trades wETH, SOL, and JUP using TCF2 indicator signals.
 * Signal: LONG when line1 crosses above line2, SHORT when below.
 */

import * as fs from 'fs';
import {
  BinanceFetcher,
  calculateTCF2Series,
  getTCF2Signal,
  calculateATRSeries,
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
  createTradingCSVLogger,
  MultiAssetBotState,
  AssetSignal,
  AssetConfig,
  BinanceInterval,
  MultiAssetManagerConfig,
  EventStore,
  JournalEmitter,
  Logger,
  getAllBalances,
} from 'trading-bot-platform';
import { loadTCF2Config, getTCF2Logger } from '../config/tcf2.js';
import { getAllAssets, getAssetsBySymbols } from '../config/assets.js';
import { getBotEnabledAssets } from '../config/bots.js';
import { hydrateMultiAssetState } from '../config/state.js';

const BOT_ID = 'tcf2';
const INDICATOR_NAME = 'TCF2';

const STATE_FILE = process.env.BOT_STATE_FILE || 'state-tcf2.json';

// Module-level state reference for graceful shutdown
let currentState: MultiAssetBotState | null = null;

// Graceful shutdown handlers
function setupShutdownHandlers(): void {
  const log = getTCF2Logger();

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

const TIMEFRAME = (process.env.BOT_TIMEFRAME || '4h').toLowerCase() === 'd1'
  ? '1d'
  : (process.env.BOT_TIMEFRAME || '4h').toLowerCase() as BinanceInterval;

function getTimeframeLabel(): string {
  return TIMEFRAME.toUpperCase();
}

function loadState(assets: AssetConfig[]): MultiAssetBotState {
  const log = getTCF2Logger();
  if (fs.existsSync(STATE_FILE)) {
    try {
      const data = fs.readFileSync(STATE_FILE, 'utf-8');
      const state = JSON.parse(data);
      log.info('Loaded existing TCF2 bot state from disk');
      return hydrateMultiAssetState(assets, state);
    } catch {
      log.warn('Failed to load state file, initializing fresh state');
      return initializeMultiAssetState(assets);
    }
  }
  log.info('No existing state found, initializing fresh state');
  return initializeMultiAssetState(assets);
}

// Indicator snapshot for dashboard display
interface IndicatorSnapshot {
  [asset: string]: {
    price: number;
    indicator: number;
    indicator2?: number;
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
    const log = getTCF2Logger();
    log.error(`Failed to create data directory: ${dataDir}`, err);
    throw new Error(`Cannot create data directory: ${dataDir}`);
  }
}

const eventStore = new EventStore({ dataDir });

function createJournalEmitter(config: ReturnType<typeof loadTCF2Config>): JournalEmitter {
  return new JournalEmitter({
    botId: BOT_ID,
    mode: config.paperMode ? 'PAPER' : 'LIVE',
    eventStore,
  });
}

function setBrokerTradeLegUsdc(broker: PaperBroker | LiveBroker, tradeLegUsdc: number): void {
  const log = getTCF2Logger();
  const mutable = broker as unknown as { config?: { tradeLegUsdc?: number } };
  if (mutable.config && typeof mutable.config.tradeLegUsdc === 'number') {
    mutable.config.tradeLegUsdc = tradeLegUsdc;
  } else {
    log.warn(`Could not set tradeLegUsdc on broker - config structure mismatch`);
  }
}

function saveState(state: MultiAssetBotState): void {
  const log = getTCF2Logger();
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
  assetSymbol: string
): Promise<Awaited<ReturnType<BinanceFetcher['fetchCandles']>>> {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fetcher.fetchCandles(limit);
    } catch (err) {
      log.warn(`${assetSymbol}: Failed to fetch ${getTimeframeLabel()} candles (attempt ${attempt}/${maxAttempts})`, err);
      if (attempt === maxAttempts) {
        throw err;
      }
      const backoffMs = 1000 * Math.pow(2, attempt - 1);
      await new Promise(resolve => setTimeout(resolve, backoffMs));
    }
  }

  return [];
}

async function processAsset(
  asset: AssetConfig,
  state: MultiAssetBotState,
  config: ReturnType<typeof loadTCF2Config>,
  broker: PaperBroker | LiveBroker,
  csvLogger: ReturnType<typeof createTradingCSVLogger>,
  journal: JournalEmitter
): Promise<AssetSignal | null> {
  const log = getTCF2Logger();

  log.info(`\n${'='.repeat(60)}`);
  log.info(`Processing: ${asset.symbol} (${asset.name})`);
  log.info('='.repeat(60));

  const fetcher = new BinanceFetcher({ symbol: asset.binanceSymbol, interval: TIMEFRAME });
  const candles = await fetchCandlesWithRetry(fetcher, 400, log, asset.symbol);
  log.info(`Fetched ${candles.length} ${getTimeframeLabel()} candles for ${asset.symbol}`);

  const tcf2Series = calculateTCF2Series(candles, config.tcf2Period, config.tcf2T3Period, config.tcf2SmoothFactor);
  const atrSeries = calculateATRSeries(candles, config.atrPeriod);

  if (tcf2Series.length < 2) {
    log.warn(`${asset.symbol}: Insufficient TCF2 data, skipping`);
    return null;
  }

  // Use -2 to get the last COMPLETED candle (latest candle may be incomplete mid-bar)
  const currentIndex = candles.length - 2;
  const tcf2Index = tcf2Series.length - 2;
  const currentTCF2 = tcf2Series[tcf2Index + 1];
  const previousTCF2 = tcf2Series[tcf2Index];
  const currentATR = atrSeries[currentIndex];
  const currentCandle = candles[currentIndex];

  if (!currentTCF2 || !previousTCF2 || currentATR === null) {
    log.warn(`${asset.symbol}: Insufficient indicator data, skipping`);
    return null;
  }

  log.info(`${asset.symbol} - Price: $${currentCandle.close.toFixed(2)}, ATR: $${currentATR.toFixed(2)}`);
  log.info(`${asset.symbol} - TCF2 Line1: ${currentTCF2.line1.toFixed(4)}, Line2: ${currentTCF2.line2.toFixed(4)}`);

  const marketContext = JournalEmitter.createMarketContext({
    price: currentCandle.close,
    indicator: currentTCF2.line1,
    indicatorName: INDICATOR_NAME,
    atr: currentATR,
    candleTime: currentCandle.timestamp,
  });

  // Update indicator snapshot for dashboard
  const indicatorTrend = currentTCF2.line1 > currentTCF2.line2 ? 'BULLISH' :
                         currentTCF2.line1 < currentTCF2.line2 ? 'BEARISH' : 'NEUTRAL';
  indicatorSnapshot[asset.symbol] = {
    price: currentCandle.close,
    indicator: currentTCF2.line1,
    indicator2: currentTCF2.line2,
    atr: currentATR,
    trend: indicatorTrend,
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

    const updatedLegs = updatePositions(
      assetPos.openLegs,
      currentCandle.close,
      currentATR,
      config.atrTrailMultiplier,
      config.breakEvenLockMultiplier
    );

    const closedLegs = updatedLegs.filter(l =>
      l.status === 'CLOSED' && !assetPos.openLegs.find(ol => ol.id === l.id && ol.status === 'CLOSED')
    );
    if (closedLegs.length > 0) {
      for (const leg of closedLegs) {
        log.info(`${asset.symbol}: ${leg.type} leg closed - ${leg.closeReason}, Entry: $${leg.entryPrice.toFixed(2)}, Exit: $${leg.closePrice?.toFixed(2)}`);
        csvLogger.logPositionLegClosure(leg, asset.symbol, config.paperMode ? 'PAPER' : 'LIVE');
      }
    }

    updateAssetPositions(state, asset.symbol, updatedLegs);
  }

  // Generate signal
  const { signal: tcf2Signal, trend } = getTCF2Signal(previousTCF2, currentTCF2);

  if (tcf2Signal !== 'NONE') {
    log.info(`${asset.symbol}: Signal detected - ${tcf2Signal}, Trend: ${trend}`);
    log.info(`${asset.symbol}: TCF2 crossover: ${previousTCF2.line1.toFixed(4)}/${previousTCF2.line2.toFixed(4)} -> ${currentTCF2.line1.toFixed(4)}/${currentTCF2.line2.toFixed(4)}`);

    journal.emit('SIGNAL_GENERATED', {
      asset: asset.symbol,
      market: marketContext,
      payload: {
        signalType: tcf2Signal,
        indicatorName: INDICATOR_NAME,
        previousIndicator: previousTCF2.line1,
        currentIndicator: currentTCF2.line1,
        indicator2: currentTCF2.line2,
        message: `${tcf2Signal} signal: TCF2 L1 ${previousTCF2.line1.toFixed(4)} -> ${currentTCF2.line1.toFixed(4)} vs L2 ${currentTCF2.line2.toFixed(4)} (trend ${trend})`,
      },
    });

    return {
      type: tcf2Signal,
      asset: asset.symbol,
      price: currentCandle.close,
      mfi: currentTCF2.line1,
      atr: currentATR,
      timestamp: currentCandle.timestamp,
    };
  }

  journal.emit('NO_SIGNAL', {
    asset: asset.symbol,
    market: marketContext,
    payload: {
      indicatorName: INDICATOR_NAME,
      indicatorValue: currentTCF2.line1,
      indicatorValue2: currentTCF2.line2,
      message: `No signal (TCF2 L1 ${currentTCF2.line1.toFixed(4)} vs L2 ${currentTCF2.line2.toFixed(4)})`,
    },
  });

  log.info(`${asset.symbol}: No signal (Trend: ${trend}, L1: ${currentTCF2.line1.toFixed(4)}, L2: ${currentTCF2.line2.toFixed(4)})`);
  return null;
}

async function runBotCycleTCF2() {
  const config = loadTCF2Config();
  const allAssets = getAllAssets();
  const enabledSymbols = getBotEnabledAssets('tcf2');
  const assets = getAssetsBySymbols(enabledSymbols);
  if (assets.length === 0) {
    const log = getTCF2Logger();
    log.error('No enabled assets found for this bot - exiting');
    process.exit(1);
  }
  const state = loadState(allAssets);
  currentState = state; // Update module-level reference for graceful shutdown
  const log = getTCF2Logger();
  const cycleStartTime = Date.now();
  const journal = createJournalEmitter(config);
  journal.startCycle();

  // Create multi-asset manager config
  const managerConfig: MultiAssetManagerConfig = {
    assets: allAssets,
    maxPositionsPerAsset: config.maxPositionsPerAsset,
    maxTotalPositions: config.maxTotalPositions,
    minTimeBetweenTradesMs: config.minTimeBetweenTradesMs,
  };

  log.info('\n' + '='.repeat(80));
  log.info(`TCF2 MULTI-ASSET BOT EXECUTION CYCLE (${getTimeframeLabel()})`);
  log.info('='.repeat(80));
  log.info(`Mode: ${config.paperMode ? 'PAPER TRADING' : 'LIVE TRADING'}`);
  log.info(`TCF2 Settings: Period=${config.tcf2Period}, T3=${config.tcf2T3Period}, Smooth=${config.tcf2SmoothFactor}`);
  log.info(`Execution Time: ${new Date().toISOString()}`);

  log.info(getMultiAssetSummary(state));

  const csvDir = process.env.BOT_CSV_DIR || 'logs/csv/tcf2';
  const csvLogger = createTradingCSVLogger({ csvDir });

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
      cbBtcMint: config.cbBtcMint,
      wbtcMint: config.wbtcMint,
      slippageBps: config.slippageBps,
      maxPriceImpactBps: config.maxPriceImpactBps,
      tradeLegUsdc: config.tradeLegUsdc,
      atrTpMultiplier: config.atrTpMultiplier,
      atrTrailMultiplier: config.atrTrailMultiplier,
      minBtcBalance: config.minBtcBalance,
      minUsdcReserve: config.minUsdcReserve,
    }, log);
    log.info('Live broker initialized');

    const walletPublicKey = broker.getWalletPublicKey();
    const connection = broker.getConnection();
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
  }

  log.info(`Trading ${assets.length} assets: ${assets.map(a => a.symbol).join(', ')}`);
  log.info(`Total capital per full signal: $${getTotalCapitalPerSignal(allAssets)}`);

  const cycleStartMarket = JournalEmitter.createMarketContext({
    price: 0,
    indicator: 0,
    indicatorName: INDICATOR_NAME,
    atr: 0,
    candleTime: Date.now(),
  });

  journal.cycleStart(cycleStartMarket, {
    assetsToProcess: assets.map(a => a.symbol),
    totalOpenPositions: getTotalOpenPositions(state),
  });

  // Track cycle metrics
  let positionsOpened = 0;
  let positionsClosed = 0;
  let runnersTrimmed = 0;

  const signals: AssetSignal[] = [];
  for (const asset of assets) {
    try {
      const signal = await processAsset(asset, state, config, broker, csvLogger, journal);
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

  log.info(`\n${'='.repeat(80)}`);
  log.info('SIGNAL PROCESSING');
  log.info('='.repeat(80));

  if (signals.length === 0) {
    log.info('No signals generated across all assets');
  } else {
    log.info(`Generated ${signals.length} signal(s):`);
    for (const signal of signals) {
      log.info(`  ${signal.asset}: ${signal.type} at $${signal.price.toFixed(2)}`);
    }

    // Process LONG signals
    const longSignals = signals.filter(s => s.type === 'LONG');
    for (const signal of longSignals) {
      const asset = assets.find(a => a.symbol === signal.asset);
      if (!asset) continue;

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
        });
        journal.signalRejected(signal.asset, rejectMarket, {
          signalType: 'LONG',
          reason: tradeCheck.reason || 'Trade filtered',
        });
        continue;
      }

      log.info(`${signal.asset}: Opening two-leg position...`);
      log.info(`  Entry Price: $${signal.price.toFixed(2)}`);
      log.info(`  Position Size: $${asset.tradeLegUsdc} per leg ($${asset.tradeLegUsdc * 2} total)`);
      log.info(`  TP Target: $${(signal.price + signal.atr * config.atrTpMultiplier).toFixed(2)}`);
      log.info(`  Breakeven Lock: $${(signal.price + signal.atr * config.breakEvenLockMultiplier).toFixed(2)}`);

      setBrokerTradeLegUsdc(broker, asset.tradeLegUsdc ?? config.tradeLegUsdc);

      const brokerSignal = {
        type: 'LONG' as const,
        entryPrice: signal.price,
        targetPrice: signal.price + signal.atr * config.atrTpMultiplier,
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
        log.warn(`${signal.asset}: Failed to open position (insufficient balance?)`);
        const failMarket = JournalEmitter.createMarketContext({
          price: signal.price,
          indicator: signal.mfi,
          indicatorName: INDICATOR_NAME,
          atr: signal.atr,
          candleTime: signal.timestamp,
        });
        journal.tradeFailed(signal.asset, failMarket, {
          signalType: 'LONG',
          reason: 'Failed to open position',
        });
      }
    }

    // Process SHORT signals
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

  log.info(`\n${'='.repeat(80)}`);
  log.info('EXECUTION COMPLETE');
  log.info('='.repeat(80));
  log.info(getMultiAssetSummary(state));

  const totalOpen = getTotalOpenPositions(state);
  log.info(`Total Open Positions: ${totalOpen}`);
  log.info(`Signals Processed: ${signals.length}`);

  state.lastProcessedCandleTime = Date.now();
  saveState(state);

  const cycleEndMarket = JournalEmitter.createMarketContext({
    price: 0,
    indicator: 0,
    indicatorName: INDICATOR_NAME,
    atr: 0,
    candleTime: Date.now(),
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

  log.info('\nTCF2 bot cycle complete\n');
}

async function main() {
  const log = getTCF2Logger();
  setupShutdownHandlers();

  try {
    const config = loadTCF2Config();

    if (config.continuousMode) {
      const { startContinuous4H } = await import('../continuous/4h.js');
      await startContinuous4H(config, runBotCycleTCF2, log);
    } else {
      log.info('Starting TCF2 Multi-Asset Trading Bot (single execution)...');
      await runBotCycleTCF2();
    }
  } catch (error) {
    log.error('Bot execution failed:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

export { runBotCycleTCF2 };
