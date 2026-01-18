/**
 * DSS-MOM Multi-Asset Bot Configuration
 *
 * Configuration loader for the DSS-MOM (DSS Averages of Momentum) bot.
 */

import { loadEnvConfig, getRequiredEnv, getOptionalEnv, getNumericEnv, getBooleanEnv, createLogger, Logger } from 'trading-bot-platform';
import { DSSMOMConfig } from './types';

// Load global env first, then per-bot env
loadEnvConfig('.env', process.env.BOT_ENV_FILE || '.env.dssmom');

let logger: Logger;

function getLogger(): Logger {
  if (!logger) {
    const logFile = process.env.BOT_LOG_FILE || 'logs/bot-dssmom.log';
    const errorFile = process.env.BOT_ERROR_LOG_FILE || 'logs/error-dssmom.log';
    logger = createLogger({
      botId: 'dssmom',
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

export function loadDSSMOMConfig(): DSSMOMConfig {
  const log = getLogger();
  log.info('Loading DSS-MOM bot configuration...');

  const config: DSSMOMConfig = {
    // RPC
    solanaRpcUrl: getRequiredEnv('SOLANA_RPC_URL'),
    solanaRpcBackup: getOptionalEnv('SOLANA_RPC_BACKUP', 'https://api.mainnet-beta.solana.com'),

    // Wallet
    walletSecretKey: getRequiredEnv('WALLET_SECRET_KEY'),

    // Tokens
    usdcMint: getRequiredEnv('USDC_MINT'),

    // DSS-MOM Settings
    dssemaPeriod: getEnvNumber('DSS_EMA_PERIOD', 8),
    dssStochPeriod: getEnvNumber('DSS_STOCH_PERIOD', 13),
    dssSignalPeriod: getEnvNumber('DSS_SIGNAL_PERIOD', 8),

    // MFI placeholder (not used by DSS-MOM but required by interface)
    mfiPeriod: 14,
    mfiBuyLevel: 20,
    mfiSellLevel: 80,

    // ATR Settings
    atrPeriod: getEnvNumber('ATR_PERIOD', 14),
    atrTpMultiplier: getEnvNumber('ATR_TP_MULT', 1.5),
    atrTrailMultiplier: getEnvNumber('ATR_TRAIL_MULT', 3.0),

    // Position Management
    breakEvenLockMultiplier: getEnvNumber('BREAKEVEN_LOCK_MULT', 0.25),

    // Risk Management
    maxPositionsPerAsset: getEnvNumber('MAX_POSITIONS_PER_ASSET', 1),
    maxTotalPositions: getEnvNumber('MAX_TOTAL_POSITIONS', 3),
    minTimeBetweenTradesMs: getEnvNumber('MIN_TIME_BETWEEN_TRADES_HOURS', 4) * 60 * 60 * 1000,

    // Execution
    continuousMode: getEnvBoolean('CONTINUOUS_MODE', true),
    executionOffsetMinutes: getEnvNumber('EXECUTION_OFFSET_MINUTES', 15),
    checkIntervalMinutes: getEnvNumber('CHECK_INTERVAL_MINUTES', 15),

    // Safety
    slippageBps: getEnvNumber('SLIPPAGE_BPS', 50),
    paperMode: getEnvBoolean('PAPER_MODE', true),
    liveTradingEnabled: getEnvBoolean('LIVE_TRADING_ENABLED', false),
  };

  // Validation
  validateDSSMOMConfig(config, log);

  log.info('DSS-MOM bot configuration loaded successfully');
  log.info(`Mode: ${config.paperMode ? 'PAPER' : 'LIVE'} trading`);
  log.info(`DSS-MOM Settings: EMA=${config.dssemaPeriod}, Stoch=${config.dssStochPeriod}, Signal=${config.dssSignalPeriod}`);
  log.info(`Continuous Mode: ${config.continuousMode}`);
  log.info(`Max Positions: ${config.maxPositionsPerAsset} per asset, ${config.maxTotalPositions} total`);

  return config;
}

function validateDSSMOMConfig(config: DSSMOMConfig, log: Logger): void {
  // DSS-MOM validation
  if (config.dssemaPeriod < 1 || config.dssemaPeriod > 100) {
    throw new Error(`DSS_EMA_PERIOD must be between 1-100, got ${config.dssemaPeriod}`);
  }
  if (config.dssStochPeriod < 1 || config.dssStochPeriod > 100) {
    throw new Error(`DSS_STOCH_PERIOD must be between 1-100, got ${config.dssStochPeriod}`);
  }
  if (config.dssSignalPeriod < 1 || config.dssSignalPeriod > 100) {
    throw new Error(`DSS_SIGNAL_PERIOD must be between 1-100, got ${config.dssSignalPeriod}`);
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

export { getLogger as getDSSMOMLogger };
