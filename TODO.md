# Allocation Guide (Idea)

Goal: Use target allocations as a guide for signal-driven buys. No forced sells.

## Desired Behavior

- Targets are percentages by asset (e.g., BTC 40, LINK 20).
- Allocations are based on total portfolio value (exclude idle USDC).
- Buy-only enforcement; sells happen only via TP or indicator exit.
- Signals drive entries; no DCA.

## Open Decisions

- Over-allocated asset behavior:
  - Block buys if at/over target, unless no other asset has a pending/likely signal.
  - Allow buys if a stronger signal is present, but cap size to avoid drifting.
- Multi-bot coordination:
  - Share a global allocation view across bots or enforce per-bot.
- Sizing:
  - Fixed per-leg size vs dynamic size from remaining allocation budget.

## Implementation Notes (When Ready)

- Add a target allocation map in config (bot-level or shared).
- Compute current allocation from on-chain holdings + open positions.
- Gate `canAssetTrade` (or equivalent) using target vs current allocation.
- Optional: add a soft buffer (e.g., +/- 2%) before blocking buys.
