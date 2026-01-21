/**
 * MFI Daily Bot Configuration
 *
 * Configuration loader for the daily BTC MFI bot.
 */

import { loadEnvConfig, getRequiredEnv, getOptionalEnv, getNumericEnv, getBooleanEnv } from 'trading-bot-platform';
import { MFIDailyConfig } from './types';

// Load global env first, then per-bot env
loadEnvConfig('.env', process.env.BOT_ENV_FILE || '.env.btc-daily');

export function loadMFIDailyConfig(): MFIDailyConfig {
  const paperMode = getBooleanEnv('PAPER_MODE', true);
  const liveTradingEnabled = getBooleanEnv('LIVE_TRADING_ENABLED', false);

  const required = [
    'SOLANA_RPC_URL',
    'USDC_MINT',
    'WBTC_MINT',
  ];

  if (!paperMode || liveTradingEnabled) {
    required.push('WALLET_SECRET_KEY');
  }

  const missing = required.filter(key => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  const cbBtcMintEnv = getOptionalEnv('CB_BTC_MINT', '');

  const config: MFIDailyConfig = {
    // RPC
    solanaRpcUrl: getRequiredEnv('SOLANA_RPC_URL'),
    solanaRpcBackup: getOptionalEnv('SOLANA_RPC_BACKUP', 'https://api.mainnet-beta.solana.com'),

    // Wallet
    walletSecretKey: getOptionalEnv('WALLET_SECRET_KEY', ''),

    // Tokens
    usdcMint: getRequiredEnv('USDC_MINT'),
    wbtcMint: getRequiredEnv('WBTC_MINT'),
    cbBtcMint: cbBtcMintEnv || undefined,

    // MFI
    mfiPeriod: getNumericEnv('MFI_PERIOD', 14),
    mfiBuyLevel: getNumericEnv('MFI_BUY_LEVEL', 30),
    mfiSellLevel: getNumericEnv('MFI_SELL_LEVEL', 70),

    // ATR
    atrPeriod: getNumericEnv('ATR_PERIOD', 14),
    atrTpMult: getNumericEnv('ATR_TP_MULT', 1.0),
    atrTrailMult: getNumericEnv('ATR_TRAIL_MULT', 2.5),

    // Trade
    tradeLegUsdc: getNumericEnv('TRADE_LEG_USDC', 100),
    maxTradesPerDay: getNumericEnv('MAX_TRADES_PER_DAY', 1),

    // Risk
    minBtcBalance: getNumericEnv('MIN_BTC_BALANCE', 0.001),
    minUsdcReserve: getNumericEnv('MIN_USDC_RESERVE', 50),

    // Execution
    slippageBps: getNumericEnv('SLIPPAGE_BPS', 50),
    maxPriceImpactBps: getNumericEnv('MAX_PRICE_IMPACT_BPS', 100),

    // Mode
    paperMode,
    liveTradingEnabled,

    // Data
    candleSource: getOptionalEnv('CANDLE_SOURCE', 'binance'),
    binanceSymbol: getOptionalEnv('BINANCE_SYMBOL', 'BTCUSDT'),

    // Timezone
    timezone: getOptionalEnv('TIMEZONE', 'UTC'),

    // Continuous Mode
    continuousMode: getBooleanEnv('CONTINUOUS_MODE', false),
    checkIntervalMinutes: getNumericEnv('CHECK_INTERVAL_MINUTES', 15),
    executionOffsetMinutes: getNumericEnv('EXECUTION_OFFSET_MINUTES', 15),
  };

  if (!config.cbBtcMint) {
    console.warn('CB_BTC_MINT not set. Using WBTC only for BTC trades.');
  }

  // Validation
  if (config.mfiPeriod < 1 || config.mfiPeriod > 100) {
    throw new Error('MFI_PERIOD must be between 1 and 100');
  }

  if (config.atrPeriod < 1 || config.atrPeriod > 100) {
    throw new Error('ATR_PERIOD must be between 1 and 100');
  }

  if (config.tradeLegUsdc < 1) {
    throw new Error('TRADE_LEG_USDC must be at least 1');
  }

  if (config.slippageBps < 0 || config.slippageBps > 1000) {
    throw new Error('SLIPPAGE_BPS must be between 0 and 1000 (0-10%)');
  }

  // Safety check
  if (config.liveTradingEnabled && config.paperMode) {
    throw new Error('Cannot enable LIVE_TRADING_ENABLED while PAPER_MODE is true');
  }
  if (!config.paperMode && !config.walletSecretKey) {
    throw new Error('WALLET_SECRET_KEY is required for live trading');
  }
  if (config.paperMode && !config.walletSecretKey) {
    console.warn('WALLET_SECRET_KEY is not set. Paper trading will run without a wallet.');
  }

  if (config.checkIntervalMinutes < 1 || config.checkIntervalMinutes > 1440) {
    throw new Error('CHECK_INTERVAL_MINUTES must be between 1 and 1440 (24 hours)');
  }

  if (config.executionOffsetMinutes < 0 || config.executionOffsetMinutes > 60) {
    throw new Error('EXECUTION_OFFSET_MINUTES must be between 0 and 60');
  }

  return config;
}
