import { describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

function writeTempEnv(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'btc-trader-'));
  const filePath = path.join(dir, '.env.test');
  fs.writeFileSync(filePath, contents, 'utf8');
  return filePath;
}

describe('config loading', () => {
  it('loads BOT_ENV_FILE overrides for MFI 4H config', async () => {
    const envPath = writeTempEnv([
      'SOLANA_RPC_URL=https://api.mainnet-beta.solana.com',
      'USDC_MINT=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      'WBTC_MINT=3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh',
      'MFI_BUY_LEVEL=25',
      'MFI_SELL_LEVEL=75',
      'TRADE_LEG_USDC=123',
      'PAPER_MODE=true',
      'CONTINUOUS_MODE=false',
    ].join('\n'));

    const previousEnv = { ...process.env };
    process.env.BOT_ENV_FILE = envPath;

    vi.resetModules();
    const { loadMFI4HConfig } = await import('../src/config/mfi-4h.js');

    const config = loadMFI4HConfig();

    expect(config.mfiBuyLevel).toBe(25);
    expect(config.mfiSellLevel).toBe(75);
    expect(config.tradeLegUsdc).toBe(123);
    expect(config.paperMode).toBe(true);
    expect(config.continuousMode).toBe(false);

    process.env = previousEnv;
    fs.rmSync(path.dirname(envPath), { recursive: true, force: true });
  });
});
