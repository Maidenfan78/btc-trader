/**
 * MFI Daily Bot - BTC Daily Timeframe
 *
 * Trades BTC on daily timeframe using MFI crossover signals.
 * Two-leg position management: TP leg + Runner leg with trailing stop.
 */

import * as fs from 'fs';
import {
  BinanceFetcher,
  calculateMFISeries,
  calculateATRSeries,
  generateSignal,
  isValidSignal,
  updatePositions,
  getOpenLegs,
  PaperBroker,
  LiveBroker,
  CircuitBreaker,
  getAllBalances,
  getBalanceSummary,
  createLogger,
  createTradingCSVLogger,
  BotState,
  Logger,
} from 'trading-bot-platform';
import { loadMFIDailyConfig } from '../config/mfi-daily';

const STATE_FILE = process.env.BOT_STATE_FILE || 'state.json';

let logger: Logger;

function getLogger(): Logger {
  if (!logger) {
    const logFile = process.env.BOT_LOG_FILE || 'logs/bot-btc.log';
    const errorFile = process.env.BOT_ERROR_LOG_FILE || 'logs/error-btc.log';
    logger = createLogger({
      botId: 'btc-daily',
      logDir: 'logs',
      logLevel: 'info',
      logFile,
      errorLogFile: errorFile,
    });
  }
  return logger;
}

function getDefaultState(): BotState {
  return {
    lastProcessedCandleTime: 0,
    lastTradeTime: 0,
    openLegs: [],
    totalTradesToday: 0,
    lastDayReset: new Date().toISOString().split('T')[0],
  };
}

function loadState(): BotState {
  if (fs.existsSync(STATE_FILE)) {
    try {
      const data = fs.readFileSync(STATE_FILE, 'utf-8');
      return JSON.parse(data);
    } catch {
      return getDefaultState();
    }
  }
  return getDefaultState();
}

function saveState(state: BotState): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

/**
 * Core bot execution logic
 */
async function runBotCycle() {
  const log = getLogger();

  try {
    log.info('=== BTC MFI Bot Starting ===');
    log.info(`Timestamp: ${new Date().toISOString()}`);

    // Load config
    const config = loadMFIDailyConfig();
    log.info(`Mode: ${config.paperMode ? 'PAPER' : 'LIVE'}`);
    log.info(`Trading: ${config.liveTradingEnabled ? 'ENABLED' : 'DISABLED'}`);

    if (!config.paperMode && !config.liveTradingEnabled) {
      log.warn('Live mode but trading disabled - will analyze only');
    }

    // Load state
    const state = loadState();
    log.info('State loaded', {
      openLegs: state.openLegs.length,
      lastProcessed: new Date(state.lastProcessedCandleTime).toISOString(),
      lastTrade: new Date(state.lastTradeTime).toISOString(),
    });

    // Initialize circuit breaker
    const circuitBreaker = new CircuitBreaker({
      maxDailyLossPct: 5.0,
      maxConsecutiveLosses: 3,
      maxDailyTrades: config.maxTradesPerDay,
      minTimeBetweenTradesMs: 24 * 60 * 60 * 1000, // 24 hours
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
        cbBtcMint: config.cbBtcMint,
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
        config.cbBtcMint,
        config.wbtcMint
      );

      // Get current price for balance summary
      const fetcher = new BinanceFetcher({ symbol: config.binanceSymbol, interval: '1d' });
      const recentCandles = await fetcher.fetchCandles(1);
      const currentBtcPrice = recentCandles[0].close;

      log.info(getBalanceSummary(balances.usdc, balances.totalBtc, currentBtcPrice));
    }

    // Fetch candles
    const numCandles = Math.max(config.mfiPeriod, config.atrPeriod) * 2;
    log.info(`Fetching ${numCandles} candles for ${config.binanceSymbol}...`);

    const fetcher = new BinanceFetcher({ symbol: config.binanceSymbol, interval: '1d' });
    const candles = await fetcher.fetchCandles(numCandles);
    const latestCandle = candles[candles.length - 1];

    log.info('Latest candle:', {
      timestamp: new Date(latestCandle.timestamp).toISOString(),
      close: latestCandle.close.toFixed(2),
      volume: latestCandle.volume.toFixed(2),
    });

    // Check if already processed
    if (latestCandle.timestamp <= state.lastProcessedCandleTime) {
      log.info('Candle already processed - nothing to do');
      log.info('Bot run complete');
      return;
    }

    // Calculate indicators
    log.info('Calculating indicators...');
    const mfiSeries = calculateMFISeries(candles, config.mfiPeriod);
    const atrSeries = calculateATRSeries(candles, config.atrPeriod);

    const currentMFI = mfiSeries[mfiSeries.length - 1];
    const previousMFI = mfiSeries[mfiSeries.length - 2];
    const currentATR = atrSeries[atrSeries.length - 1];

    if (currentMFI === null || previousMFI === null || currentATR === null) {
      log.error('Insufficient data to calculate indicators');
      return;
    }

    log.info('Indicators calculated:', {
      previousMFI: previousMFI.toFixed(2),
      currentMFI: currentMFI.toFixed(2),
      currentATR: currentATR.toFixed(2),
    });

    // Update existing positions
    if (state.openLegs.length > 0) {
      log.info(`Updating ${state.openLegs.length} open position(s)...`);

      const updatedLegs = updatePositions(state.openLegs, latestCandle.close, currentATR);

      // Close any legs that hit targets/stops
      for (let i = 0; i < updatedLegs.length; i++) {
        const leg = updatedLegs[i];
        const wasOpen = state.openLegs[i].status === 'OPEN';
        const nowClosed = leg.status === 'CLOSED';

        if (wasOpen && nowClosed) {
          log.info(`Closing ${leg.type} leg: ${leg.closeReason}`);

          await broker.closeLeg(leg, latestCandle, leg.closeReason || 'Unknown');

          // Log to CSV
          csvLogger.logPositionLegClosure(
            leg,
            'BTC',
            config.paperMode ? 'PAPER' : 'LIVE'
          );
        }
      }

      state.openLegs = updatedLegs;

      const stillOpen = getOpenLegs(state.openLegs).length;
      log.info(`Position update complete - ${stillOpen} still open`);
    }

    // Generate signal
    log.info('Generating signal...');

    const signal = generateSignal(
      previousMFI,
      currentMFI,
      latestCandle.close,
      currentATR,
      latestCandle.timestamp,
      config.mfiBuyLevel,
      config.mfiSellLevel
    );

    log.info(`Signal: ${signal.type}`, {
      mfi: `${previousMFI.toFixed(2)} -> ${currentMFI.toFixed(2)}`,
      price: latestCandle.close.toFixed(2),
      atr: currentATR.toFixed(2),
    });

    // Execute signal
    if (isValidSignal(signal)) {
      if (signal.type === 'LONG') {
        const canTradeCheck = circuitBreaker.canTrade();

        if (!canTradeCheck.allowed) {
          log.warn('Trade blocked by circuit breaker:', canTradeCheck.reason);
        } else if (config.liveTradingEnabled || config.paperMode) {
          log.info('LONG Signal - Opening Position');

          const newLegs = await broker.openPosition(signal, latestCandle);

          if (newLegs) {
            state.openLegs = [...state.openLegs, ...newLegs];
            state.lastTradeTime = latestCandle.timestamp;

            log.info('Position opened successfully');
            log.info(`Open legs: ${getOpenLegs(state.openLegs).length}`);

            // Log to CSV
            const totalUSDC = newLegs.reduce((sum, leg) => sum + (leg.entryPrice * leg.quantity), 0);
            const totalQty = newLegs.reduce((sum, leg) => sum + leg.quantity, 0);

            csvLogger.logTradeEntry({
              date: new Date(latestCandle.timestamp).toISOString(),
              timestamp: latestCandle.timestamp,
              asset: 'BTC',
              action: 'OPEN',
              signalType: 'LONG',
              mfi: signal.mfi,
              atr: signal.atr,
              price: latestCandle.close,
              totalUSDC,
              totalQuantity: totalQty,
              legsOpened: newLegs.length,
              targetPrice: newLegs[0].targetPrice || 0,
              trailingStop: newLegs[0].trailingStop || 0,
              mode: config.paperMode ? 'PAPER' : 'LIVE',
            });
          } else {
            log.error('Failed to open position');
          }
        }
      } else if (signal.type === 'SHORT') {
        log.info('SHORT Signal - Trimming runners');

        const beforeCount = getOpenLegs(state.openLegs).filter((l) => l.type === 'RUNNER').length;

        if (beforeCount > 0) {
          state.openLegs = await broker.trimRunners(state.openLegs, signal, latestCandle);

          // Log trimmed runners
          const trimmedRunners = state.openLegs.filter(
            leg => leg.type === 'RUNNER' && leg.status === 'CLOSED' && leg.closeTime === latestCandle.timestamp
          );
          csvLogger.logPositionLegClosures(trimmedRunners, 'BTC', config.paperMode ? 'PAPER' : 'LIVE');

          const afterCount = getOpenLegs(state.openLegs).filter((l) => l.type === 'RUNNER').length;
          log.info(`Trimmed ${beforeCount - afterCount} runner(s)`);
        } else {
          log.info('No runners to trim');
        }
      }
    }

    // Save state
    state.lastProcessedCandleTime = latestCandle.timestamp;
    saveState(state);
    log.info('State saved');

    // Final summary
    log.info(circuitBreaker.getSummary());
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
  const config = loadMFIDailyConfig();

  if (config.continuousMode) {
    log.info('CONTINUOUS MODE ENABLED');
    log.info('Bot will run 24/7, executing after new candles form');

    // Import continuous mode handler
    const { startContinuousMode } = await import('../continuous/daily.js');
    await startContinuousMode(
      config,
      () => loadState().lastProcessedCandleTime,
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
