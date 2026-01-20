/**
 * MFI 4H Multi-Asset Trading Bot
 *
 * Trades wETH, SOL, and JUP on 4-hour timeframe using MFI signals.
 * Research-backed parameters: MFI 20/80, TP 1.5xATR, Trail 3.0xATR.
 */

import * as fs from 'fs';
import * as path from 'path';
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
  createTradingCSVLogger,
  MultiAssetBotState,
  AssetSignal,
  AssetConfig,
  MultiAssetManagerConfig,
  EventStore,
  JournalEmitter,
  MarketContext,
} from 'trading-bot-platform';
import { loadMFI4HConfig, getMFI4HLogger } from '../config/mfi-4h.js';
import { getAllAssets, getAssetsBySymbols } from '../config/assets.js';
import { getBotEnabledAssets } from '../config/bots.js';
import { hydrateMultiAssetState } from '../config/state.js';

const STATE_FILE = process.env.BOT_STATE_FILE || 'state-4h.json';

function loadState(assets: AssetConfig[]): MultiAssetBotState {
  const log = getMFI4HLogger();
  if (fs.existsSync(STATE_FILE)) {
    try {
      const data = fs.readFileSync(STATE_FILE, 'utf-8');
      const state = JSON.parse(data);
      log.info('Loaded existing 4H bot state from disk');
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
  const log = getMFI4HLogger();
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
    const log = getMFI4HLogger();
    log.error(`Failed to create data directory: ${dataDir}`, err);
    throw new Error(`Cannot create data directory: ${dataDir}`);
  }
}

const eventStore = new EventStore({ dataDir });

function createJournalEmitter(config: ReturnType<typeof loadMFI4HConfig>): JournalEmitter {
  return new JournalEmitter({
    botId: '4h-mfi',
    mode: config.paperMode ? 'PAPER' : 'LIVE',
    eventStore,
  });
}

/**
 * Process a single asset
 */
async function processAsset(
  asset: AssetConfig,
  state: MultiAssetBotState,
  config: ReturnType<typeof loadMFI4HConfig>,
  broker: PaperBroker,
  csvLogger: ReturnType<typeof createTradingCSVLogger>,
  journal: JournalEmitter
): Promise<AssetSignal | null> {
  const log = getMFI4HLogger();

  log.info(`\n${'='.repeat(60)}`);
  log.info(`Processing: ${asset.symbol} (${asset.name})`);
  log.info('='.repeat(60));

  // Fetch candles
  const fetcher = new BinanceFetcher({ symbol: asset.binanceSymbol, interval: '4h' });
  const candles = await fetcher.fetchCandles(400);
  log.info(`Fetched ${candles.length} 4H candles for ${asset.symbol}`);

  // Calculate indicators
  const mfiSeries = calculateMFISeries(candles, config.mfiPeriod);
  const atrSeries = calculateATRSeries(candles, config.atrPeriod);

  const currentIndex = candles.length - 2; // Last completed candle
  const currentMFI = mfiSeries[currentIndex];
  const previousMFI = mfiSeries[currentIndex - 1];
  const currentATR = atrSeries[currentIndex];
  const currentCandle = candles[currentIndex];

  if (currentMFI === null || previousMFI === null || currentATR === null) {
    log.warn(`${asset.symbol}: Insufficient indicator data, skipping`);
    return null;
  }

  log.info(`${asset.symbol} - Price: $${currentCandle.close.toFixed(2)}, MFI: ${currentMFI.toFixed(2)}, ATR: $${currentATR.toFixed(2)}`);

  // Create market context for journal events
  const marketContext = JournalEmitter.createMarketContext({
    price: currentCandle.close,
    indicator: currentMFI,
    indicatorName: 'MFI',
    atr: currentATR,
    candleTime: currentCandle.timestamp,
    buyLevel: config.mfiBuyLevel,
    sellLevel: config.mfiSellLevel,
  });

  // Update indicator snapshot for dashboard
  const trend = currentMFI <= config.mfiBuyLevel ? 'BULLISH' :
                currentMFI >= config.mfiSellLevel ? 'BEARISH' : 'NEUTRAL';
  indicatorSnapshot[asset.symbol] = {
    price: currentCandle.close,
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

    const updatedLegs = updatePositions(
      assetPos.openLegs,
      currentCandle.close,
      currentATR,
      config.atrTrailMultiplier,
      config.breakEvenLockMultiplier
    );

    // Log closed legs and emit journal events
    const closedLegs = updatedLegs.filter(l =>
      l.status === 'CLOSED' && !assetPos.openLegs.find(ol => ol.id === l.id && ol.status === 'CLOSED')
    );
    if (closedLegs.length > 0) {
      for (const leg of closedLegs) {
        log.info(`${asset.symbol}: ${leg.type} leg closed - ${leg.closeReason}, Entry: $${leg.entryPrice.toFixed(2)}, Exit: $${leg.closePrice?.toFixed(2)}`);
        csvLogger.logPositionLegClosure(leg, asset.symbol, config.paperMode ? 'PAPER' : 'LIVE');

        // Emit journal event for closed leg
        const pnlUsdc = leg.closePrice ? (leg.closePrice - leg.entryPrice) * leg.quantity : 0;
        const pnlPercent = leg.closePrice ? ((leg.closePrice - leg.entryPrice) / leg.entryPrice) * 100 : 0;
        const holdingPeriodMs = leg.closeTime ? leg.closeTime - leg.entryTime : 0;

        if (leg.type === 'TP' && leg.closeReason === 'TP_HIT') {
          journal.tpHit(asset.symbol, marketContext, {
            legId: leg.id,
            entryPrice: leg.entryPrice,
            exitPrice: leg.closePrice || currentCandle.close,
            quantity: leg.quantity,
            pnlUsdc,
            pnlPercent,
            holdingPeriodMs,
          }, leg.id);
        } else if (leg.type === 'RUNNER' && leg.closeReason === 'TRAILING_STOP_HIT') {
          journal.trailingStopHit(asset.symbol, marketContext, {
            legId: leg.id,
            entryPrice: leg.entryPrice,
            exitPrice: leg.closePrice || currentCandle.close,
            highestReached: leg.highestPrice || leg.entryPrice,
            quantity: leg.quantity,
            pnlUsdc,
            pnlPercent,
            holdingPeriodMs,
          }, leg.id);
        }
      }
    }

    updateAssetPositions(state, asset.symbol, updatedLegs);
  }

  // Generate signal
  const signal = generateSignal(
    previousMFI,
    currentMFI,
    currentCandle.close,
    currentATR,
    currentCandle.timestamp,
    config.mfiBuyLevel,
    config.mfiSellLevel
  );

  if (isValidSignal(signal)) {
    log.info(`${asset.symbol}: Signal detected - ${signal.type}, MFI ${previousMFI.toFixed(2)} -> ${currentMFI.toFixed(2)}`);

    // Emit signal generated event
    journal.signalGenerated(asset.symbol, marketContext, {
      signalType: signal.type as 'LONG' | 'SHORT',
      previousIndicator: previousMFI,
      currentIndicator: currentMFI,
      buyLevel: config.mfiBuyLevel,
      sellLevel: config.mfiSellLevel,
      crossDirection: signal.type === 'LONG' ? 'UP' : 'DOWN',
    });

    return {
      type: signal.type,
      asset: asset.symbol,
      price: currentCandle.close,
      mfi: currentMFI,
      atr: currentATR,
      timestamp: currentCandle.timestamp,
    };
  }

  // Emit no signal event
  journal.noSignal(asset.symbol, marketContext, {
    indicatorValue: currentMFI,
    buyLevel: config.mfiBuyLevel,
    sellLevel: config.mfiSellLevel,
    reason: currentMFI > config.mfiBuyLevel && currentMFI < config.mfiSellLevel
      ? 'MFI between levels'
      : 'No crossover detected',
  });

  log.info(`${asset.symbol}: No signal (MFI: ${currentMFI.toFixed(2)})`);
  return null;
}

/**
 * Main bot execution cycle
 */
async function runBotCycle4H() {
  const cycleStartTime = Date.now();
  const config = loadMFI4HConfig();
  const allAssets = getAllAssets();
  const enabledSymbols = getBotEnabledAssets('4h-mfi');
  const assets = getAssetsBySymbols(enabledSymbols);
  const state = loadState(allAssets);
  const log = getMFI4HLogger();

  // Initialize journal emitter
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
  log.info('4H MULTI-ASSET BOT EXECUTION CYCLE');
  log.info('='.repeat(80));
  log.info(`Mode: ${config.paperMode ? 'PAPER TRADING' : 'LIVE TRADING'}`);
  log.info(`MFI Levels: ${config.mfiBuyLevel}/${config.mfiSellLevel}`);
  log.info(`Execution Time: ${new Date().toISOString()}`);

  // Show current position summary
  log.info(getMultiAssetSummary(state));

  // Initialize CSV logger
  const csvDir = process.env.BOT_CSV_DIR || 'logs/csv/4h-mfi';
  const csvLogger = createTradingCSVLogger({ csvDir });

  // Initialize broker
  const broker = new PaperBroker({
    initialUsdcBalance: 10000,
    initialBtcBalance: 0,
    slippageBps: config.slippageBps,
    tradeLegUsdc: 100,
  });

  log.info(`Trading ${assets.length} assets: ${assets.map(a => a.symbol).join(', ')}`);
  log.info(`Total capital per full signal: $${getTotalCapitalPerSignal(allAssets)}`);

  // Emit cycle start event
  const cycleStartMarket = JournalEmitter.createMarketContext({
    price: 0,
    indicator: 0,
    indicatorName: 'MFI',
    atr: 0,
    candleTime: Date.now(),
    buyLevel: config.mfiBuyLevel,
    sellLevel: config.mfiSellLevel,
  });
  journal.cycleStart(cycleStartMarket, {
    assetsToProcess: assets.map(a => a.symbol),
    totalOpenPositions: getTotalOpenPositions(state),
  });

  // Track cycle metrics
  let positionsOpened = 0;
  let positionsClosed = 0;
  let runnersTrimmed = 0;

  // Process each asset
  const signals: AssetSignal[] = [];
  for (const asset of assets) {
    try {
      const signal = await processAsset(asset, state, config, broker, csvLogger, journal);
      if (signal) {
        signals.push(signal);
      }
    } catch (error) {
      log.error(`Error processing ${asset.symbol}:`, error);
      // Emit error event
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

      // Check if we can trade
      const tradeCheck = canAssetTrade(
        state,
        signal.asset,
        managerConfig,
        signal.timestamp
      );

      if (!tradeCheck.canTrade) {
        log.info(`${signal.asset}: LONG signal filtered - ${tradeCheck.reason}`);

        // Emit signal rejected event
        const rejectMarket = JournalEmitter.createMarketContext({
          price: signal.price,
          indicator: signal.mfi,
          indicatorName: 'MFI',
          atr: signal.atr,
          candleTime: signal.timestamp,
          buyLevel: config.mfiBuyLevel,
          sellLevel: config.mfiSellLevel,
        });
        journal.signalRejected(signal.asset, rejectMarket, {
          signalType: 'LONG',
          reason: tradeCheck.reason || 'Unknown',
        });
        continue;
      }

      // Open position
      log.info(`${signal.asset}: Opening two-leg position...`);
      log.info(`  Entry Price: $${signal.price.toFixed(2)}`);
      log.info(`  Position Size: $${asset.tradeLegUsdc} per leg ($${asset.tradeLegUsdc * 2} total)`);
      log.info(`  TP Target: $${(signal.price + signal.atr * config.atrTpMultiplier).toFixed(2)}`);
      log.info(`  Breakeven Lock: $${(signal.price + signal.atr * config.breakEvenLockMultiplier).toFixed(2)}`);

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

          // Emit position opened event
          const openMarket = JournalEmitter.createMarketContext({
            price: signal.price,
            indicator: signal.mfi,
            indicatorName: 'MFI',
            atr: signal.atr,
            candleTime: signal.timestamp,
            buyLevel: config.mfiBuyLevel,
            sellLevel: config.mfiSellLevel,
          });
          journal.positionOpened(signal.asset, openMarket, {
            legIds: newLegs.map(l => l.id),
            entryPrice: signal.price,
            fillPrice: newLegs[0].entryPrice,
            slippageUsdc: (newLegs[0].entryPrice - signal.price) * totalQty,
            totalUsdc: totalUSDC,
            totalQuantity: totalQty,
            tpTarget: newLegs[0].targetPrice || 0,
            breakevenLock: signal.price + signal.atr * config.breakEvenLockMultiplier,
            atrUsed: signal.atr,
          }, newLegs[0].id);
        }
      } else {
        log.warn(`${signal.asset}: Failed to open position (insufficient balance?)`);

        // Emit trade failed event
        const failMarket = JournalEmitter.createMarketContext({
          price: signal.price,
          indicator: signal.mfi,
          indicatorName: 'MFI',
          atr: signal.atr,
          candleTime: signal.timestamp,
          buyLevel: config.mfiBuyLevel,
          sellLevel: config.mfiSellLevel,
        });
        journal.tradeFailed(signal.asset, failMarket, {
          reason: 'Insufficient balance',
          signalType: 'LONG',
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

        // Emit runner trimmed events
        const trimMarket = JournalEmitter.createMarketContext({
          price: signal.price,
          indicator: signal.mfi,
          indicatorName: 'MFI',
          atr: signal.atr,
          candleTime: signal.timestamp,
          buyLevel: config.mfiBuyLevel,
          sellLevel: config.mfiSellLevel,
        });
        for (const leg of trimmedRunners) {
          const pnlUsdc = leg.closePrice ? (leg.closePrice - leg.entryPrice) * leg.quantity : 0;
          const pnlPercent = leg.closePrice ? ((leg.closePrice - leg.entryPrice) / leg.entryPrice) * 100 : 0;
          const holdingPeriodMs = leg.closeTime ? leg.closeTime - leg.entryTime : 0;

          journal.runnerTrimmed(signal.asset, trimMarket, {
            legId: leg.id,
            entryPrice: leg.entryPrice,
            exitPrice: leg.closePrice || signal.price,
            quantity: leg.quantity,
            pnlUsdc,
            pnlPercent,
            holdingPeriodMs,
            triggerIndicator: signal.mfi,
            triggerLevel: config.mfiSellLevel,
          }, leg.id);
          runnersTrimmed++;
        }

        updateAssetPositions(state, signal.asset, updatedLegs);

        const runnersAfter = updatedLegs.filter(l => l.type === 'RUNNER' && l.status === 'OPEN').length;
        log.info(`${signal.asset}: Trimmed ${runnersBefore - runnersAfter} runner(s)`);
      }
    }
  }

  // Final summary
  log.info(`\n${'='.repeat(80)}`);
  log.info('EXECUTION COMPLETE');
  log.info('='.repeat(80));
  log.info(getMultiAssetSummary(state));

  const totalOpen = getTotalOpenPositions(state);
  log.info(`Total Open Positions: ${totalOpen}`);
  log.info(`Signals Processed: ${signals.length}`);

  // Save state
  state.lastProcessedCandleTime = Date.now();
  saveState(state);

  // Emit cycle end event
  const cycleEndMarket = JournalEmitter.createMarketContext({
    price: 0,
    indicator: 0,
    indicatorName: 'MFI',
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

  log.info('\n4H bot cycle complete\n');
}

/**
 * Main entry point
 */
async function main() {
  const log = getMFI4HLogger();

  try {
    const config = loadMFI4HConfig();

    if (config.continuousMode) {
      const { startContinuous4H } = await import('../continuous/4h.js');
      await startContinuous4H(config, runBotCycle4H, log);
    } else {
      log.info('Starting 4H Multi-Asset Trading Bot (single execution)...');
      await runBotCycle4H();
    }
  } catch (error) {
    log.error('Bot execution failed:', error);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

export { runBotCycle4H };
