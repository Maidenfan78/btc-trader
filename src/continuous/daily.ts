/**
 * Continuous Mode for Daily Bots
 *
 * Runs 24/7 to detect new daily candles and execute trading logic
 * with configurable offset to avoid high volatility at candle close.
 */

import { MFIDailyConfig } from '../config/types';
import { createLogger, Logger } from 'trading-bot-platform';

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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getMillisecondsUntilNextCandle(): number {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  tomorrow.setUTCHours(0, 0, 0, 0);
  return tomorrow.getTime() - now.getTime();
}

function getMillisecondsSinceLastCandle(): number {
  const now = new Date();
  const today = new Date(now);
  today.setUTCHours(0, 0, 0, 0);
  return now.getTime() - today.getTime();
}

function isInExecutionWindow(
  lastProcessedTime: number,
  executionOffsetMinutes: number
): boolean {
  const msSinceCandle = getMillisecondsSinceLastCandle();
  const offsetMs = executionOffsetMinutes * 60 * 1000;

  if (msSinceCandle < offsetMs) {
    return false;
  }

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const todayCandleTime = today.getTime();

  if (lastProcessedTime >= todayCandleTime) {
    return false;
  }

  return true;
}

function getNextCheckTime(
  lastProcessedTime: number,
  executionOffsetMinutes: number,
  checkIntervalMinutes: number
): { sleepMs: number; reason: string } {
  const msSinceCandle = getMillisecondsSinceLastCandle();
  const offsetMs = executionOffsetMinutes * 60 * 1000;

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const todayCandleTime = today.getTime();

  if (lastProcessedTime >= todayCandleTime) {
    const msUntilNextCandle = getMillisecondsUntilNextCandle();
    const sleepMs = msUntilNextCandle + offsetMs;

    const wakeTime = new Date(Date.now() + sleepMs);
    return {
      sleepMs,
      reason: `Already processed today. Next check: ${wakeTime.toISOString()}`,
    };
  }

  if (msSinceCandle < offsetMs) {
    const sleepMs = offsetMs - msSinceCandle;
    const wakeTime = new Date(Date.now() + sleepMs);

    return {
      sleepMs,
      reason: `Waiting for execution offset (${executionOffsetMinutes}min after candle). Next check: ${wakeTime.toISOString()}`,
    };
  }

  return {
    sleepMs: 0,
    reason: 'In execution window - checking now',
  };
}

export async function startContinuousMode(
  config: MFIDailyConfig,
  getLastProcessedTime: () => number,
  executeBot: () => Promise<void>
): Promise<void> {
  const log = getLogger();

  log.info('=== Starting Continuous Monitoring Mode ===');
  log.info(`Check interval: ${config.checkIntervalMinutes} minutes`);
  log.info(`Execution offset: ${config.executionOffsetMinutes} minutes after candle close`);
  log.info(`Timezone: ${config.timezone}`);
  log.info('Daily candles close at 00:00 UTC');
  log.info('Bot will execute at 00:00 + offset (to avoid volatility)');
  log.info('');

  let isWaiting = false;

  while (true) {
    try {
      const lastProcessed = getLastProcessedTime();

      if (isInExecutionWindow(lastProcessed, config.executionOffsetMinutes)) {
        if (isWaiting) {
          log.info('');
          isWaiting = false;
        }

        log.info('Execution window reached - running bot...');
        log.info('');

        await executeBot();

        log.info('');
        log.info('Bot execution complete');

        const msUntilNextCandle = getMillisecondsUntilNextCandle();
        const nextCheckMs = msUntilNextCandle + (config.executionOffsetMinutes * 60 * 1000);
        const nextCheckTime = new Date(Date.now() + nextCheckMs);

        log.info(`Next execution: ${nextCheckTime.toISOString()}`);
        log.info(`Sleeping for ${(nextCheckMs / 1000 / 60 / 60).toFixed(1)} hours...`);
        log.info('');

        await sleep(nextCheckMs);
        isWaiting = false;
      } else {
        const { sleepMs, reason } = getNextCheckTime(
          lastProcessed,
          config.executionOffsetMinutes,
          config.checkIntervalMinutes
        );

        if (!isWaiting) {
          log.info(reason);
          isWaiting = true;
        }

        const actualSleepMs = Math.min(sleepMs, config.checkIntervalMinutes * 60 * 1000);

        if (actualSleepMs > 0) {
          await sleep(actualSleepMs);
        } else {
          await sleep(1000);
        }
      }
    } catch (error: any) {
      log.error('Error in continuous monitoring loop:', {
        error: error.message,
        stack: error.stack,
      });

      log.info(`Retrying in ${config.checkIntervalMinutes} minutes...`);
      await sleep(config.checkIntervalMinutes * 60 * 1000);
      isWaiting = false;
    }
  }
}

export function getTimeUntilNextCandle(): string {
  const ms = getMillisecondsUntilNextCandle();
  const hours = Math.floor(ms / (1000 * 60 * 60));
  const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));

  return `${hours}h ${minutes}m`;
}
