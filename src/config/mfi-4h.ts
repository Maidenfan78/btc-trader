/**
 * MFI 4H Multi-Asset Bot Configuration
 *
 * Configuration loader for the 4H multi-asset MFI bot.
 */

import { loadEnvConfig, getRequiredEnv, getOptionalEnv, getNumericEnv, getBooleanEnv, createLogger, Logger } from 'trading-bot-platform';
import { MultiAssetConfig } from './types';

// Load global env first, then per-bot env
loadEnvConfig('.env', process.env.BOT_ENV_FILE || '.env.4h');

let logger: Logger;

function getLogger(): Logger {
  if (!logger) {
    const logFile = process.env.BOT_LOG_FILE || 'logs/bot-4h.log';
    const errorFile = process.env.BOT_ERROR_LOG_FILE || 'logs/error-4h.log';
    logger = createLogger({
      botId: '4h-mfi',
      logDir: 'logs',
      logLevel: 'info',
      logFile,
      errorLogFile: errorFile,
    });
  }
  return logger;
}

function getEnvNumber(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (!value) return defaultValue;
  const num = parseFloat(value);
  if (isNaN(num)) {
    throw new Error(`Invalid number for ${key}: ${value}`);
  }
  return num;
}

function getEnvBoolean(key: string, defaultValue: boolean): boolean {
  const value = process.env[key];
  if (!value) return defaultValue;
  return value.toLowerCase() === 'true';
}

export function loadMFI4HConfig(): MultiAssetConfig {
  const log = getLogger();
  log.info('Loading 4H MFI bot configuration...');

  const config: MultiAssetConfig = {
    // RPC
    solanaRpcUrl: getRequiredEnv('SOLANA_RPC_URL'),
    solanaRpcBackup: getOptionalEnv('SOLANA_RPC_BACKUP', 'https://api.mainnet-beta.solana.com'),

    // Wallet
    walletSecretKey: getRequiredEnv('WALLET_SECRET_KEY'),

    // Tokens
    usdcMint: getRequiredEnv('USDC_MINT'),

    // MFI Settings
    mfiPeriod: getEnvNumber('MFI_PERIOD', 14),
    mfiBuyLevel: getEnvNumber('MFI_BUY_LEVEL', 20),   // Research winner: 20
    mfiSellLevel: getEnvNumber('MFI_SELL_LEVEL', 80), // Research winner: 80

    // ATR Settings
    atrPeriod: getEnvNumber('ATR_PERIOD', 14),
    atrTpMultiplier: getEnvNumber('ATR_TP_MULT', 1.5),      // Research optimal
    atrTrailMultiplier: getEnvNumber('ATR_TRAIL_MULT', 3.0), // Research optimal

    // Position Management
    breakEvenLockMultiplier: getEnvNumber('BREAKEVEN_LOCK_MULT', 0.25),

    // Risk Management
    maxPositionsPerAsset: getEnvNumber('MAX_POSITIONS_PER_ASSET', 1),
    maxTotalPositions: getEnvNumber('MAX_TOTAL_POSITIONS', 3),
    minTimeBetweenTradesMs: getEnvNumber('MIN_TIME_BETWEEN_TRADES_HOURS', 4) * 60 * 60 * 1000,

    // Execution (4H specific)
    continuousMode: getEnvBoolean('CONTINUOUS_MODE', true),
    executionOffsetMinutes: getEnvNumber('EXECUTION_OFFSET_MINUTES', 15),
    checkIntervalMinutes: getEnvNumber('CHECK_INTERVAL_MINUTES', 15),

    // Safety
    slippageBps: getEnvNumber('SLIPPAGE_BPS', 50),
    paperMode: getEnvBoolean('PAPER_MODE', true),
    liveTradingEnabled: getEnvBoolean('LIVE_TRADING_ENABLED', false),
  };

  // Validation
  validateMultiAssetConfig(config, log);

  log.info('4H MFI bot configuration loaded successfully');
  log.info(`Mode: ${config.paperMode ? 'PAPER' : 'LIVE'} trading`);
  log.info(`MFI Levels: ${config.mfiBuyLevel}/${config.mfiSellLevel}`);
  log.info(`Continuous Mode: ${config.continuousMode}`);
  log.info(`Max Positions: ${config.maxPositionsPerAsset} per asset, ${config.maxTotalPositions} total`);

  return config;
}

function validateMultiAssetConfig(config: MultiAssetConfig, log: Logger): void {
  // MFI validation
  if (config.mfiBuyLevel < 0 || config.mfiBuyLevel > 100) {
    throw new Error(`MFI_BUY_LEVEL must be between 0-100, got ${config.mfiBuyLevel}`);
  }
  if (config.mfiSellLevel < 0 || config.mfiSellLevel > 100) {
    throw new Error(`MFI_SELL_LEVEL must be between 0-100, got ${config.mfiSellLevel}`);
  }
  if (config.mfiBuyLevel >= config.mfiSellLevel) {
    throw new Error(`MFI_BUY_LEVEL (${config.mfiBuyLevel}) must be less than MFI_SELL_LEVEL (${config.mfiSellLevel})`);
  }

  // Execution timing validation
  if (config.executionOffsetMinutes < 0 || config.executionOffsetMinutes > 60) {
    throw new Error(`EXECUTION_OFFSET_MINUTES must be between 0-60, got ${config.executionOffsetMinutes}`);
  }
  if (config.checkIntervalMinutes < 1 || config.checkIntervalMinutes > 1440) {
    throw new Error(`CHECK_INTERVAL_MINUTES must be between 1-1440, got ${config.checkIntervalMinutes}`);
  }

  // Position limits validation
  if (config.maxPositionsPerAsset < 1) {
    throw new Error(`MAX_POSITIONS_PER_ASSET must be at least 1, got ${config.maxPositionsPerAsset}`);
  }
  if (config.maxTotalPositions < config.maxPositionsPerAsset) {
    throw new Error(`MAX_TOTAL_POSITIONS (${config.maxTotalPositions}) must be >= MAX_POSITIONS_PER_ASSET (${config.maxPositionsPerAsset})`);
  }

  // Safety check for live trading
  if (!config.paperMode && !config.liveTradingEnabled) {
    throw new Error('PAPER_MODE=false requires LIVE_TRADING_ENABLED=true');
  }

  log.info('Configuration validation passed');
}

export { getLogger as getMFI4HLogger };
