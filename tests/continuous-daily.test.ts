import { describe, expect, it, vi } from 'vitest';

describe('continuous/daily timing helper', () => {
  it('computes time until next candle in UTC', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T23:30:00Z'));
    vi.resetModules();

    const { getTimeUntilNextCandle } = await import('../src/continuous/daily.js');

    expect(getTimeUntilNextCandle()).toBe('0h 30m');

    vi.useRealTimers();
  });
});
