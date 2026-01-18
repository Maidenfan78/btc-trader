/**
 * Asset Configuration for btc-trader
 *
 * Defines the tradable assets and their configurations.
 */

import { AssetConfig } from 'trading-bot-platform';

/**
 * Default assets for multi-asset trading
 */
export const DEFAULT_ASSETS: AssetConfig[] = [
  {
    symbol: 'wETH',
    name: 'Wrapped Ethereum',
    binanceSymbol: 'ETHUSDT',
    solanaMint: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
    tradeLegUsdc: 100,
    enabled: true,
  },
  {
    symbol: 'SOL',
    name: 'Solana',
    binanceSymbol: 'SOLUSDT',
    solanaMint: 'So11111111111111111111111111111111111111112',
    tradeLegUsdc: 100,
    enabled: true,
  },
  {
    symbol: 'JUP',
    name: 'Jupiter',
    binanceSymbol: 'JUPUSDT',
    solanaMint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
    tradeLegUsdc: 100,
    enabled: true,
  },
];

/**
 * Get asset configuration from environment or defaults
 */
export function getAssets(): AssetConfig[] {
  // Could extend to load from env or config file
  return DEFAULT_ASSETS;
}
