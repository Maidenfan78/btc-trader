/**
 * TDFI (Trend Direction & Force Index) Multi-Asset Trading Bot
 *
 * Trades wETH, SOL, and JUP using TDFI indicator signals.
 * Signal: LONG when TDFI crosses above trigger level, SHORT when below.
 */

import * as fs from 'fs';
import {
  BinanceFetcher,
  calculateTDFISeries,
  getTDFISignal,
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
  MarketContext,
} from 'trading-bot-platform';
import { loadTDFIConfig, getTDFILogger } from '../config/tdfi.js';
import { getAllAssets, getAssetsBySymbols } from '../config/assets.js';
import { getBotEnabledAssets } from '../config/bots.js';
import { hydrateMultiAssetState } from '../config/state.js';

const BOT_ID = 'tdfi';
const INDICATOR_NAME = 'TDFI';

const STATE_FILE = process.env.BOT_STATE_FILE || 'state-tdfi.json';
const TIMEFRAME = (process.env.BOT_TIMEFRAME || '4h').toLowerCase() === 'd1'
  ? '1d'
  : (process.env.BOT_TIMEFRAME || '4h').toLowerCase() as BinanceInterval;

function getTimeframeLabel(): string {
  return TIMEFRAME.toUpperCase();
}

function loadState(assets: AssetConfig[]): MultiAssetBotState {
  const log = getTDFILogger();
  if (fs.existsSync(STATE_FILE)) {
    try {
      const data = fs.readFileSync(STATE_FILE, 'utf-8');
      const state = JSON.parse(data);
      log.info('Loaded existing TDFI bot state from disk');
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
    const log = getTDFILogger();
    log.error(`Failed to create data directory: ${dataDir}`, err);
    throw new Error(`Cannot create data directory: ${dataDir}`);
  }
}

const eventStore = new EventStore({ dataDir });

function createJournalEmitter(config: ReturnType<typeof loadTDFIConfig>): JournalEmitter {
  return new JournalEmitter({
    botId: BOT_ID,
    mode: config.paperMode ? 'PAPER' : 'LIVE',
    eventStore,
  });
}

function setBrokerTradeLegUsdc(broker: PaperBroker | LiveBroker, tradeLegUsdc: number): void {
  const mutable = broker as unknown as { config?: { tradeLegUsdc?: number } };
  if (mutable.config) {
    mutable.config.tradeLegUsdc = tradeLegUsdc;
  }
}

function saveState(state: MultiAssetBotState): void {
  const log = getTDFILogger();
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

async function processAsset(
  asset: AssetConfig,
  state: MultiAssetBotState,
  config: ReturnType<typeof loadTDFIConfig>,
  broker: PaperBroker | LiveBroker,
  csvLogger: ReturnType<typeof createTradingCSVLogger>,
  journal: JournalEmitter
): Promise<AssetSignal | null> {
  const log = getTDFILogger();

  log.info(`\n${'='.repeat(60)}`);
  log.info(`Processing: ${asset.symbol} (${asset.name})`);
  log.info('='.repeat(60));

  const fetcher = new BinanceFetcher({ symbol: asset.binanceSymbol, interval: TIMEFRAME });
  const candles = await fetcher.fetchCandles(400);
  log.info(`Fetched ${candles.length} ${getTimeframeLabel()} candles for ${asset.symbol}`);

  const tdfiSeries = calculateTDFISeries(candles, config.tdfiPeriod);
  const atrSeries = calculateATRSeries(candles, config.atrPeriod);

  if (tdfiSeries.length < 2) {
    log.warn(`${asset.symbol}: Insufficient TDFI data, skipping`);
    return null;
  }

  const currentIndex = candles.length - 2;
  const tdfiIndex = tdfiSeries.length - 2;
  const currentTDFI = tdfiSeries[tdfiIndex + 1];
  const previousTDFI = tdfiSeries[tdfiIndex];
  const currentATR = atrSeries[currentIndex];
  const currentCandle = candles[currentIndex];

  if (!currentTDFI || !previousTDFI || currentATR === null) {
    log.warn(`${asset.symbol}: Insufficient indicator data, skipping`);
    return null;
  }

  log.info(`${asset.symbol} - Price: $${currentCandle.close.toFixed(2)}, ATR: $${currentATR.toFixed(2)}`);
  log.info(`${asset.symbol} - TDFI Value: ${currentTDFI.value.toFixed(4)}`);

  const marketContext = JournalEmitter.createMarketContext({
    price: currentCandle.close,
    indicator: currentTDFI.value,
    indicatorName: INDICATOR_NAME,
    atr: currentATR,
    candleTime: currentCandle.timestamp,
  });

  // Update indicator snapshot for dashboard
  const indicatorTrend = currentTDFI.value > config.tdfiTrigger ? 'BULLISH' :
                         currentTDFI.value < -config.tdfiTrigger ? 'BEARISH' : 'NEUTRAL';
  indicatorSnapshot[asset.symbol] = {
    price: currentCandle.close,
    indicator: currentTDFI.value,
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
        csvLogger.logPositionLegClosure(leg, asset.symbol, config.paperMode ? 'PAPER' : 'LIVE');
      }
    }

    updateAssetPositions(state, asset.symbol, updatedLegs);
  }

  // Generate signal
  const { signal: tdfiSignal, trend } = getTDFISignal(previousTDFI, currentTDFI, config.tdfiTrigger);

  if (tdfiSignal !== 'NONE') {
    log.info(`${asset.symbol}: Signal detected - ${tdfiSignal}, Trend: ${trend}`);

    journal.emit('SIGNAL_GENERATED', {
      asset: asset.symbol,
      market: marketContext,
      payload: {
        signalType: tdfiSignal,
        indicatorName: INDICATOR_NAME,
        previousIndicator: previousTDFI.value,
        currentIndicator: currentTDFI.value,
        triggerLevel: config.tdfiTrigger,
        message: `${tdfiSignal} signal: TDFI ${previousTDFI.value.toFixed(4)} -> ${currentTDFI.value.toFixed(4)} (trigger ${config.tdfiTrigger})`,
      },
    });

    return {
      type: tdfiSignal,
      asset: asset.symbol,
      price: currentCandle.close,
      mfi: currentTDFI.value,
      atr: currentATR,
      timestamp: currentCandle.timestamp,
    };
  }

  journal.emit('NO_SIGNAL', {
    asset: asset.symbol,
    market: marketContext,
    payload: {
      indicatorName: INDICATOR_NAME,
      indicatorValue: currentTDFI.value,
      triggerLevel: config.tdfiTrigger,
      message: `No signal (TDFI ${currentTDFI.value.toFixed(4)}, trigger ${config.tdfiTrigger})`,
    },
  });

  log.info(`${asset.symbol}: No signal (TDFI: ${currentTDFI.value.toFixed(4)})`);
  return null;
}

async function runBotCycleTDFI() {
  const config = loadTDFIConfig();
  const allAssets = getAllAssets();
  const enabledSymbols = getBotEnabledAssets('tdfi');
  const assets = getAssetsBySymbols(enabledSymbols);
  const state = loadState(allAssets);
  const log = getTDFILogger();
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
  log.info(`TDFI MULTI-ASSET BOT EXECUTION CYCLE (${getTimeframeLabel()})`);
  log.info('='.repeat(80));
  log.info(`Mode: ${config.paperMode ? 'PAPER TRADING' : 'LIVE TRADING'}`);
  log.info(`TDFI Settings: Period=${config.tdfiPeriod}, Trigger=${config.tdfiTrigger}`);
  log.info(`Execution Time: ${new Date().toISOString()}`);

  log.info(getMultiAssetSummary(state));

  const csvDir = process.env.BOT_CSV_DIR || 'logs/csv/tdfi';
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
    positionsOpened: 0,
    positionsClosed: 0,
    runnersTrimmed: 0,
    cycleDurationMs: Date.now() - cycleStartTime,
  });
  journal.endCycle();

  log.info('\nTDFI bot cycle complete\n');
}

async function main() {
  const log = getTDFILogger();

  try {
    const config = loadTDFIConfig();

    if (config.continuousMode) {
      const { startContinuous4H } = await import('../continuous/4h.js');
      await startContinuous4H(config, runBotCycleTDFI, log);
    } else {
      log.info('Starting TDFI Multi-Asset Trading Bot (single execution)...');
      await runBotCycleTDFI();
    }
  } catch (error) {
    log.error('Bot execution failed:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

export { runBotCycleTDFI };
