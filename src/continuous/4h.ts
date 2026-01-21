/**
 * Continuous Mode for 4H Bots
 *
 * Runs 24/7 to detect new 4-hour candles and execute trading logic.
 * Supports 1H, 4H, and 1D timeframes.
 */

import { Logger } from 'trading-bot-platform';

interface ContinuousConfig {
  continuousMode: boolean;
  executionOffsetMinutes: number;
  checkIntervalMinutes: number;
}

const TIMEFRAME = (process.env.BOT_TIMEFRAME || '4h').toLowerCase() === 'd1'
  ? '1d'
  : (process.env.BOT_TIMEFRAME || '4h').toLowerCase();

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getLastCandleCloseTime(): number {
  const now = new Date();

  if (TIMEFRAME === '1h') {
    const last = new Date(now);
    last.setUTCMinutes(0, 0, 0);
    return last.getTime();
  }

  if (TIMEFRAME === '1d') {
    const last = new Date(now);
    last.setUTCHours(0, 0, 0, 0);
    return last.getTime();
  }

  // 4H timeframe
  const currentHour = now.getUTCHours();
  const fourHourBoundaries = [0, 4, 8, 12, 16, 20];
  let lastBoundary = 0;
  for (let i = fourHourBoundaries.length - 1; i >= 0; i--) {
    if (currentHour >= fourHourBoundaries[i]) {
      lastBoundary = fourHourBoundaries[i];
      break;
    }
  }
  const last = new Date(now);
  last.setUTCHours(lastBoundary, 0, 0, 0);
  return last.getTime();
}

function getNextCandleCloseTime(): number {
  const last = getLastCandleCloseTime();
  const duration = TIMEFRAME === '1h'
    ? 60 * 60 * 1000
    : TIMEFRAME === '1d'
      ? 24 * 60 * 60 * 1000
      : 4 * 60 * 60 * 1000;
  return last + duration;
}

function getTimeframeLabel(): string {
  return TIMEFRAME.toUpperCase();
}

export async function startContinuous4H(
  config: ContinuousConfig,
  runBotCycle: () => Promise<void>,
  log: Logger
): Promise<void> {
  log.info('\n' + '='.repeat(80));
  log.info(`BOT - CONTINUOUS MODE (${getTimeframeLabel()})`);
  log.info('='.repeat(80));
  log.info(`Execution offset: ${config.executionOffsetMinutes} minutes after candle close`);
  log.info(`Check interval: ${config.checkIntervalMinutes} minutes`);
  log.info('Press Ctrl+C to stop\n');

  let lastExecutedCandle = 0;

  while (true) {
    const lastCandleClose = getLastCandleCloseTime();
    const executionTime = lastCandleClose + config.executionOffsetMinutes * 60 * 1000;
    const windowMs = TIMEFRAME === '1h'
      ? 20 * 60 * 1000
      : TIMEFRAME === '1d'
        ? 60 * 60 * 1000
        : 30 * 60 * 1000;
    const windowEnd = executionTime + windowMs;

    if (Date.now() >= executionTime && Date.now() <= windowEnd && lastCandleClose > lastExecutedCandle) {
      log.info(`${getTimeframeLabel()} candle closed at ${new Date(lastCandleClose).toISOString()}, executing bot cycle...`);
      lastExecutedCandle = lastCandleClose;

      try {
        await runBotCycle();
      } catch (error) {
        log.error('Bot cycle failed:', error);
      }
    }

    const nextClose = getNextCandleCloseTime();
    const nextExecution = nextClose + config.executionOffsetMinutes * 60 * 1000;
    const msUntilNext = Math.max(0, nextExecution - Date.now());
    const checkInterval = Math.min(config.checkIntervalMinutes * 60 * 1000, msUntilNext);

    log.info(`Next check in ${Math.round(checkInterval / 60000)} minutes (next ${getTimeframeLabel()}: ${new Date(nextExecution).toISOString()})`);

    await sleep(checkInterval);
  }
}

export { getLastCandleCloseTime, getNextCandleCloseTime, getTimeframeLabel };
