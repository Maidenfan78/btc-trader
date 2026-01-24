/**
 * DSS-MOM (DSS Averages of Momentum) Multi-Asset Trading Bot
 *
 * Trades wETH, SOL, and JUP using DSS-MOM indicator signals.
 * Signal: LONG when DSS crosses above signal from oversold, SHORT when below from overbought.
 */

import * as fs from 'fs';
import {
  BinanceFetcher,
  calculateDSSMOMSeries,
  getDSSMOMSignal,
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
import { loadDSSMOMConfig, getDSSMOMLogger } from '../config/dssmom.js';
import { getAllAssets, getAssetsBySymbols } from '../config/assets.js';
import { getBotEnabledAssets } from '../config/bots.js';
import { hydrateMultiAssetState } from '../config/state.js';

const BOT_ID = 'dssmom';
const INDICATOR_NAME = 'DSS-MOM';

const STATE_FILE = process.env.BOT_STATE_FILE || 'state-dssmom.json';

// Module-level state reference for graceful shutdown
let currentState: MultiAssetBotState | null = null;

// Graceful shutdown handlers
function setupShutdownHandlers(): void {
  const log = getDSSMOMLogger();

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
  const log = getDSSMOMLogger();
  if (fs.existsSync(STATE_FILE)) {
    try {
      const data = fs.readFileSync(STATE_FILE, 'utf-8');
      const state = JSON.parse(data);
      log.info('Loaded existing DSS-MOM bot state from disk');
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
    const log = getDSSMOMLogger();
    log.error(`Failed to create data directory: ${dataDir}`, err);
    throw new Error(`Cannot create data directory: ${dataDir}`);
  }
}

const eventStore = new EventStore({ dataDir });

function createJournalEmitter(config: ReturnType<typeof loadDSSMOMConfig>): JournalEmitter {
  return new JournalEmitter({
    botId: BOT_ID,
    mode: config.paperMode ? 'PAPER' : 'LIVE',
    eventStore,
  });
}

function setBrokerTradeLegUsdc(broker: PaperBroker | LiveBroker, tradeLegUsdc: number): void {
  const log = getDSSMOMLogger();
  const mutable = broker as unknown as { config?: { tradeLegUsdc?: number } };
  if (mutable.config && typeof mutable.config.tradeLegUsdc === 'number') {
    mutable.config.tradeLegUsdc = tradeLegUsdc;
  } else {
    log.warn(`Could not set tradeLegUsdc on broker - config structure mismatch`);
  }
}

function saveState(state: MultiAssetBotState): void {
  const log = getDSSMOMLogger();
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
  config: ReturnType<typeof loadDSSMOMConfig>,
  broker: PaperBroker | LiveBroker,
  csvLogger: ReturnType<typeof createTradingCSVLogger>,
  journal: JournalEmitter,
  cycleMetrics: { positionsClosed: number }
): Promise<AssetSignal | null> {
  const log = getDSSMOMLogger();

  log.info(`\n${'='.repeat(60)}`);
  log.info(`Processing: ${asset.symbol} (${asset.name})`);
  log.info('='.repeat(60));

  const fetcher = new BinanceFetcher({ symbol: asset.binanceSymbol, interval: TIMEFRAME });
  const candles = await fetchCandlesWithRetry(fetcher, 400, log, asset.symbol);
  log.info(`Fetched ${candles.length} ${getTimeframeLabel()} candles for ${asset.symbol}`);

  const dssmomSeries = calculateDSSMOMSeries(candles, config.dssemaPeriod, config.dssStochPeriod, config.dssSignalPeriod);
  const atrSeries = calculateATRSeries(candles, config.atrPeriod);

  if (dssmomSeries.length < 2) {
    log.warn(`${asset.symbol}: Insufficient DSS-MOM data, skipping`);
    return null;
  }

  // Use -2 to get the last COMPLETED candle (latest candle may be incomplete mid-bar)
  // Use -2 to get the last COMPLETED candle (latest candle may be incomplete mid-bar)
  const currentIndex = candles.length - 2;
  const dssIndex = dssmomSeries.length - 2;
  const currentDSS = dssmomSeries[dssIndex + 1];
  const previousDSS = dssmomSeries[dssIndex];
  const currentATR = atrSeries[currentIndex];
  const currentCandle = candles[currentIndex];

  if (!currentDSS || !previousDSS || currentATR === null) {
    log.warn(`${asset.symbol}: Insufficient indicator data, skipping`);
    return null;
  }

  log.info(`${asset.symbol} - Price: $${currentCandle.close.toFixed(2)}, ATR: $${currentATR.toFixed(2)}`);
  log.info(`${asset.symbol} - DSS: ${currentDSS.dss.toFixed(2)}, Signal: ${currentDSS.signal.toFixed(2)}`);

  const marketContext = JournalEmitter.createMarketContext({
    price: currentCandle.close,
    indicator: currentDSS.dss,
    indicatorName: INDICATOR_NAME,
    atr: currentATR,
    candleTime: currentCandle.timestamp,
  });

  // Update indicator snapshot for dashboard
  const indicatorTrend = currentDSS.dss > currentDSS.signal ? 'BULLISH' :
                         currentDSS.dss < currentDSS.signal ? 'BEARISH' : 'NEUTRAL';
  indicatorSnapshot[asset.symbol] = {
    price: currentCandle.close,
    indicator: currentDSS.dss,
    indicator2: currentDSS.signal,
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
        log.info(`${asset.symbol}: ${leg.type} leg closed - ${leg.closeReason}`);
        try {
          await broker.closeLeg(leg, currentCandle, leg.closeReason || 'Unknown');
        } catch (err) {
          log.error(`${asset.symbol}: Failed to close ${leg.type} leg ${leg.id}`, err);
        }
        csvLogger.logPositionLegClosure(leg, asset.symbol, config.paperMode ? 'PAPER' : 'LIVE');
      }

      cycleMetrics.positionsClosed += closedLegs.length;
    }

    updateAssetPositions(state, asset.symbol, updatedLegs);
  }

  // Generate signal
  const { signal: dssSignal, trend } = getDSSMOMSignal(previousDSS, currentDSS);

  if (dssSignal !== 'NONE') {
    log.info(`${asset.symbol}: Signal detected - ${dssSignal}, Trend: ${trend}`);

    journal.emit('SIGNAL_GENERATED', {
      asset: asset.symbol,
      market: marketContext,
      payload: {
        signalType: dssSignal,
        indicatorName: INDICATOR_NAME,
        previousIndicator: previousDSS.dss,
        currentIndicator: currentDSS.dss,
        indicator2: currentDSS.signal,
        message: `${dssSignal} signal: DSS ${previousDSS.dss.toFixed(2)} -> ${currentDSS.dss.toFixed(2)} (signal ${currentDSS.signal.toFixed(2)}, trend ${trend})`,
      },
    });

    return {
      type: dssSignal,
      asset: asset.symbol,
      price: currentCandle.close,
      mfi: currentDSS.dss,
      atr: currentATR,
      timestamp: currentCandle.timestamp,
    };
  }

  journal.emit('NO_SIGNAL', {
    asset: asset.symbol,
    market: marketContext,
    payload: {
      indicatorName: INDICATOR_NAME,
      indicatorValue: currentDSS.dss,
      indicatorValue2: currentDSS.signal,
      message: `No signal (DSS ${currentDSS.dss.toFixed(2)} vs signal ${currentDSS.signal.toFixed(2)})`,
    },
  });

  log.info(`${asset.symbol}: No signal (DSS: ${currentDSS.dss.toFixed(2)})`);
  return null;
}

async function runBotCycleDSSMOM() {
  const config = loadDSSMOMConfig();
  const allAssets = getAllAssets();
  const enabledSymbols = getBotEnabledAssets('dssmom');
  const assets = getAssetsBySymbols(enabledSymbols);
  if (assets.length === 0) {
    const log = getDSSMOMLogger();
    log.error('No enabled assets found for this bot - exiting');
    process.exit(1);
  }
  const state = loadState(allAssets);
  currentState = state; // Update module-level reference for graceful shutdown
  const log = getDSSMOMLogger();
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
  log.info(`DSS-MOM MULTI-ASSET BOT EXECUTION CYCLE (${getTimeframeLabel()})`);
  log.info('='.repeat(80));
  log.info(`Mode: ${config.paperMode ? 'PAPER TRADING' : 'LIVE TRADING'}`);
  log.info(`DSS-MOM Settings: EMA=${config.dssemaPeriod}, Stoch=${config.dssStochPeriod}, Signal=${config.dssSignalPeriod}`);
  log.info(`Execution Time: ${new Date().toISOString()}`);

  log.info(getMultiAssetSummary(state));

  const csvDir = process.env.BOT_CSV_DIR || 'logs/csv/dssmom';
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
  const cycleMetrics = { positionsClosed: 0 };
  let runnersTrimmed = 0;

  const signals: AssetSignal[] = [];
  for (const asset of assets) {
    try {
      const signal = await processAsset(asset, state, config, broker, csvLogger, journal, cycleMetrics);
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
      }
    }

    // Process SHORT signals
    const shortSignals = signals.filter(s => s.type === 'SHORT');
    for (const signal of shortSignals) {
      const assetPos = getAssetPositions(state, signal.asset);
      if (!assetPos) continue;

      const openRunners = assetPos.openLegs.filter(l => l.type === 'RUNNER' && l.status === 'OPEN');
      const profitableRunners = openRunners.filter(l => signal.price >= l.entryPrice);
      const unprofitableCount = openRunners.length - profitableRunners.length;

      if (unprofitableCount > 0) {
        log.info(`${signal.asset}: SHORT signal - skipping ${unprofitableCount} unprofitable runner(s)`);
      }

      if (profitableRunners.length > 0) {
        log.info(`${signal.asset}: SHORT signal - trimming ${profitableRunners.length} profitable runner(s)`);

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

        // Only pass profitable runners to trimRunners, keep unprofitable ones unchanged
        const nonRunnerLegs = assetPos.openLegs.filter(l => l.type !== 'RUNNER' || l.status !== 'OPEN');
        const unprofitableRunners = openRunners.filter(l => signal.price < l.entryPrice);

        const updatedProfitableLegs = await broker.trimRunners(profitableRunners, brokerSignal, candle);

        // Merge: non-runners + unprofitable runners (unchanged) + updated profitable runners
        const allUpdatedLegs = [...nonRunnerLegs, ...unprofitableRunners, ...updatedProfitableLegs];

        const trimmedRunners = updatedProfitableLegs.filter(
          leg => leg.type === 'RUNNER' && leg.status === 'CLOSED' && leg.closeTime === signal.timestamp
        );
        csvLogger.logPositionLegClosures(trimmedRunners, signal.asset, config.paperMode ? 'PAPER' : 'LIVE');
        runnersTrimmed += trimmedRunners.length;

        updateAssetPositions(state, signal.asset, allUpdatedLegs);

        log.info(`${signal.asset}: Trimmed ${trimmedRunners.length} runner(s)`);
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
    positionsClosed: cycleMetrics.positionsClosed,
    runnersTrimmed,
    cycleDurationMs: Date.now() - cycleStartTime,
  });
  journal.endCycle();

  log.info('\nDSS-MOM bot cycle complete\n');
}

async function main() {
  const log = getDSSMOMLogger();
  setupShutdownHandlers();

  try {
    const config = loadDSSMOMConfig();

    if (config.continuousMode) {
      const { startContinuous4H } = await import('../continuous/4h.js');
      await startContinuous4H(config, runBotCycleDSSMOM, log);
    } else {
      log.info('Starting DSS-MOM Multi-Asset Trading Bot (single execution)...');
      await runBotCycleDSSMOM();
    }
  } catch (error) {
    log.error('Bot execution failed:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

export { runBotCycleDSSMOM };
