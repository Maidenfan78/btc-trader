/**
 * Asset Configuration for btc-trader
 *
 * Loads tradable assets from assets.json and merges with
 * Solana mint addresses from environment variables.
 */

import { AssetConfig } from 'trading-bot-platform';
import * as fs from 'fs';
import * as path from 'path';

/** Asset definition from assets.json (without solanaMint) */
interface AssetDefinition {
  symbol: string;
  name: string;
  binanceSymbol: string;
  tradeLegUsdc: number;
}

/** Map of symbol -> environment variable name for mints */
const MINT_ENV_MAP: Record<string, string> = {
  wETH: 'ETH_MINT',
  SOL: 'SOL_MINT',
  JUP: 'JUP_MINT',
  WBTC: 'WBTC_MINT',
  LINK: 'LINK_MINT',
  AAVE: 'AAVE_MINT',
  RENDER: 'RENDER_MINT',
  UNI: 'UNI_MINT',
};

/** Cache for loaded assets */
let cachedAssets: AssetConfig[] | null = null;

/**
 * Load all assets from assets.json and merge with env mints
 */
export function getAllAssets(): AssetConfig[] {
  if (cachedAssets) {
    return cachedAssets;
  }

  const assetsPath = path.join(process.cwd(), 'assets.json');

  if (!fs.existsSync(assetsPath)) {
    console.warn(`Warning: assets.json not found at ${assetsPath}, using empty list`);
    return [];
  }

  const rawData = fs.readFileSync(assetsPath, 'utf-8');
  const definitions: AssetDefinition[] = JSON.parse(rawData);

  cachedAssets = definitions.map((def) => {
    const envKey = MINT_ENV_MAP[def.symbol];
    const solanaMint = envKey ? process.env[envKey] : undefined;

    return {
      symbol: def.symbol,
      name: def.name,
      binanceSymbol: def.binanceSymbol,
      solanaMint,
      tradeLegUsdc: def.tradeLegUsdc,
      enabled: true, // All assets enabled by default; filtering happens via bots.json
    };
  });

  return cachedAssets;
}

/**
 * Get assets filtered by symbol list
 */
export function getAssetsBySymbols(symbols: string[]): AssetConfig[] {
  const all = getAllAssets();
  const symbolSet = new Set(symbols.map((s) => s.toUpperCase()));

  return all.filter((asset) => symbolSet.has(asset.symbol.toUpperCase()));
}

/**
 * Clear the asset cache (useful for testing or hot reload)
 */
export function clearAssetCache(): void {
  cachedAssets = null;
}

/**
 * Legacy function for backward compatibility
 * @deprecated Use getAllAssets() or getAssetsBySymbols() instead
 */
export function getAssets(): AssetConfig[] {
  return getAllAssets();
}

/**
 * Default assets for backward compatibility
 * @deprecated Assets are now loaded from assets.json
 */
export const DEFAULT_ASSETS: AssetConfig[] = [];
