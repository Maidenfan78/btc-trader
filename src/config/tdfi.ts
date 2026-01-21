/**
 * TDFI Multi-Asset Bot Configuration
 *
 * Configuration loader for the TDFI (Trend Direction & Force Index) bot.
 */

import { loadEnvConfig, getRequiredEnv, getOptionalEnv, getNumericEnv, getBooleanEnv, createLogger, Logger } from 'trading-bot-platform';
import { TDFIConfig } from './types';

// Load global env first, then per-bot env
loadEnvConfig('.env', process.env.BOT_ENV_FILE || '.env.tdfi');

let logger: Logger;

function getLogger(): Logger {
  if (!logger) {
    const logFile = process.env.BOT_LOG_FILE || 'logs/bot-tdfi.log';
    const errorFile = process.env.BOT_ERROR_LOG_FILE || 'logs/error-tdfi.log';
    logger = createLogger({
      botId: 'tdfi',
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

export function loadTDFIConfig(): TDFIConfig {
  const log = getLogger();
  log.info('Loading TDFI bot configuration...');

  const config: TDFIConfig = {
    // RPC
    solanaRpcUrl: getRequiredEnv('SOLANA_RPC_URL'),
    solanaRpcBackup: getOptionalEnv('SOLANA_RPC_BACKUP', 'https://api.mainnet-beta.solana.com'),

    // Wallet
    walletSecretKey: getOptionalEnv('WALLET_SECRET_KEY', ''),

    // Tokens
    usdcMint: getRequiredEnv('USDC_MINT'),
    wbtcMint: getRequiredEnv('WBTC_MINT'),
    cbBtcMint: getOptionalEnv('CB_BTC_MINT', '') || undefined,

    // TDFI Settings
    tdfiPeriod: getEnvNumber('TDFI_PERIOD', 20),
    tdfiTrigger: getEnvNumber('TDFI_TRIGGER', 0.05),

    // MFI placeholder (not used by TDFI but required by interface)
    mfiPeriod: 14,
    mfiBuyLevel: 20,
    mfiSellLevel: 80,

    // ATR Settings
    atrPeriod: getEnvNumber('ATR_PERIOD', 14),
    atrTpMultiplier: getEnvNumber('ATR_TP_MULT', 1.5),
    atrTrailMultiplier: getEnvNumber('ATR_TRAIL_MULT', 3.0),

    // Position Management
    breakEvenLockMultiplier: getEnvNumber('BREAKEVEN_LOCK_MULT', 0.25),

    // Trade Settings
    tradeLegUsdc: getEnvNumber('TRADE_LEG_USDC', 100),

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
    maxPriceImpactBps: getEnvNumber('MAX_PRICE_IMPACT_BPS', 100),
    minBtcBalance: getEnvNumber('MIN_BTC_BALANCE', 0.001),
    minUsdcReserve: getEnvNumber('MIN_USDC_RESERVE', 50),
    paperMode: getEnvBoolean('PAPER_MODE', true),
    liveTradingEnabled: getEnvBoolean('LIVE_TRADING_ENABLED', false),
  };

  // Validation
  validateTDFIConfig(config, log);

  log.info('TDFI bot configuration loaded successfully');
  log.info(`Mode: ${config.paperMode ? 'PAPER' : 'LIVE'} trading`);
  log.info(`TDFI Settings: Period=${config.tdfiPeriod}, Trigger=${config.tdfiTrigger}`);
  log.info(`Continuous Mode: ${config.continuousMode}`);
  log.info(`Max Positions: ${config.maxPositionsPerAsset} per asset, ${config.maxTotalPositions} total`);

  return config;
}

function validateTDFIConfig(config: TDFIConfig, log: Logger): void {
  // TDFI validation
  if (config.tdfiPeriod < 1 || config.tdfiPeriod > 100) {
    throw new Error(`TDFI_PERIOD must be between 1-100, got ${config.tdfiPeriod}`);
  }
  if (config.tdfiTrigger <= 0 || config.tdfiTrigger >= 1) {
    throw new Error(`TDFI_TRIGGER must be between 0-1, got ${config.tdfiTrigger}`);
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

  if (config.tradeLegUsdc < 1) {
    throw new Error(`TRADE_LEG_USDC must be at least 1, got ${config.tradeLegUsdc}`);
  }

  if (config.slippageBps < 0 || config.slippageBps > 1000) {
    throw new Error(`SLIPPAGE_BPS must be between 0-1000, got ${config.slippageBps}`);
  }
  if (config.maxPriceImpactBps < 0 || config.maxPriceImpactBps > 1000) {
    throw new Error(`MAX_PRICE_IMPACT_BPS must be between 0-1000, got ${config.maxPriceImpactBps}`);
  }

  // Safety check for live trading
  if (!config.paperMode && !config.liveTradingEnabled) {
    throw new Error('PAPER_MODE=false requires LIVE_TRADING_ENABLED=true');
  }
  if (!config.paperMode && !config.walletSecretKey) {
    throw new Error('WALLET_SECRET_KEY is required for live trading');
  }
  if (!config.paperMode && !config.wbtcMint) {
    throw new Error('WBTC_MINT is required for live trading');
  }
  if (config.paperMode && !config.walletSecretKey) {
    log.warn('WALLET_SECRET_KEY is not set. Paper trading will run without a wallet.');
  }

  log.info('Configuration validation passed');
}

export { getLogger as getTDFILogger };
