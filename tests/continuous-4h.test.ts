import { describe, expect, it, vi } from 'vitest';

describe('continuous/4h timeframe helpers', () => {
  it('computes 4H candle boundaries', async () => {
    process.env.BOT_TIMEFRAME = '4h';
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T06:30:00Z'));
    vi.resetModules();

    const { getLastCandleCloseTime, getNextCandleCloseTime } = await import('../src/continuous/4h.js');

    expect(new Date(getLastCandleCloseTime()).toISOString()).toBe('2024-01-01T04:00:00.000Z');
    expect(new Date(getNextCandleCloseTime()).toISOString()).toBe('2024-01-01T08:00:00.000Z');

    vi.useRealTimers();
  });

  it('computes 1H candle boundaries', async () => {
    process.env.BOT_TIMEFRAME = '1h';
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T06:30:00Z'));
    vi.resetModules();

    const { getLastCandleCloseTime, getNextCandleCloseTime } = await import('../src/continuous/4h.js');

    expect(new Date(getLastCandleCloseTime()).toISOString()).toBe('2024-01-01T06:00:00.000Z');
    expect(new Date(getNextCandleCloseTime()).toISOString()).toBe('2024-01-01T07:00:00.000Z');

    vi.useRealTimers();
  });

  it('computes 1D candle boundaries from d1 timeframe alias', async () => {
    process.env.BOT_TIMEFRAME = 'd1';
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T13:45:00Z'));
    vi.resetModules();

    const { getLastCandleCloseTime, getNextCandleCloseTime } = await import('../src/continuous/4h.js');

    expect(new Date(getLastCandleCloseTime()).toISOString()).toBe('2024-01-01T00:00:00.000Z');
    expect(new Date(getNextCandleCloseTime()).toISOString()).toBe('2024-01-02T00:00:00.000Z');

    vi.useRealTimers();
  });
});
