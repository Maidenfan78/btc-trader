/**
 * Configuration Types for btc-trader
 *
 * These extend the platform types with specific config structures
 * used by the bot implementations in this repository.
 */

export interface MFIDailyConfig {
  // RPC
  solanaRpcUrl: string;
  solanaRpcBackup: string;

  // Wallet
  walletSecretKey: string;

  // Tokens
  usdcMint: string;
  wbtcMint: string;
  cbBtcMint?: string;

  // MFI Settings
  mfiPeriod: number;
  mfiBuyLevel: number;
  mfiSellLevel: number;

  // ATR Settings
  atrPeriod: number;
  atrTpMult: number;
  atrTrailMult: number;

  // Trade Settings
  tradeLegUsdc: number;
  maxTradesPerDay: number;

  // Risk Settings
  minBtcBalance: number;
  minUsdcReserve: number;

  // Execution
  slippageBps: number;
  maxPriceImpactBps: number;

  // Mode
  paperMode: boolean;
  liveTradingEnabled: boolean;

  // Data
  candleSource: string;
  binanceSymbol: string;

  // Timezone
  timezone: string;

  // Continuous Mode
  continuousMode: boolean;
  checkIntervalMinutes: number;
  executionOffsetMinutes: number;
}

export interface MultiAssetConfig {
  // RPC
  solanaRpcUrl: string;
  solanaRpcBackup: string;

  // Wallet
  walletSecretKey: string;

  // Tokens
  usdcMint: string;

  // MFI Settings (for MFI bots)
  mfiPeriod: number;
  mfiBuyLevel: number;
  mfiSellLevel: number;

  // ATR Settings
  atrPeriod: number;
  atrTpMultiplier: number;
  atrTrailMultiplier: number;
  breakEvenLockMultiplier: number;

  // Position Limits
  maxPositionsPerAsset: number;
  maxTotalPositions: number;
  minTimeBetweenTradesMs: number;

  // Execution
  continuousMode: boolean;
  executionOffsetMinutes: number;
  checkIntervalMinutes: number;

  // Safety
  slippageBps: number;
  paperMode: boolean;
  liveTradingEnabled: boolean;
}

export interface TCF2Config extends MultiAssetConfig {
  tcf2Period: number;
  tcf2T3Period: number;
  tcf2SmoothFactor: number;
}

export interface KPSSConfig extends MultiAssetConfig {
  kpssPeriod: number;
  kpssSmooth: number;
}

export interface TDFIConfig extends MultiAssetConfig {
  tdfiPeriod: number;
  tdfiTrigger: number;
}

export interface DSSMOMConfig extends MultiAssetConfig {
  dssemaPeriod: number;
  dssStochPeriod: number;
  dssSignalPeriod: number;
}
