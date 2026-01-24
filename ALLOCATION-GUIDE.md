# ALLOCATION-GUIDE.md
## Portfolio Allocation & Capital Control for btc-trader

This document defines the **portfolio-level allocation system** used by `btc-trader`.

It is designed to work with:
- Multiple bots (testing phase)
- Multiple indicators and timeframes
- A single shared Solana wallet
- Spot trading via Jupiter
- Buy-only enforcement (no forced sells)

---

## 1. Purpose

The allocation system exists to solve these problems:

- Prevent one bot or indicator from consuming all capital
- Prevent allocation drift over time
- Allow inactive assets to remain inactive without blocking others
- Ensure fair forward-testing across strategies
- Transition cleanly to a single-bot production setup

---

## 2. Core Principles (Non-Negotiable)

1. **Signals decide WHEN to buy**
2. **Allocation logic decides IF and HOW MUCH**
3. **No forced sells** (exits only via TP, stop, or indicator logic)
4. **Capital is global** (no reserved slices per asset)
5. **Allocation enforcement is buy-side only**

---

## 3. Portfolio Valuation Model

### Recommended Model (Default)
- Total portfolio value includes:
  - Idle USDC
  - All token holdings (mark-to-market)

```
totalValue = USDC + Σ(tokenValues)
```

This prevents:
- Artificial over-allocation
- Dead capital scenarios
- Incorrect weight calculations

(Excluding USDC may be added later as an optional flag.)

---

## 4. Target Allocations

Target allocations are **static percentages** defined per asset.

Example:
```json
{
  "wBTC": 0.40,
  "wETH": 0.30,
  "SOL": 0.20,
  "JUP": 0.10
}
```

Rules:
- Targets are global (shared across all bots)
- Targets change only via config edits
- Bots never modify targets

---

## 5. Allocation Bands (Drift Control)

Instead of hard targets, each asset uses a **band**:

```
minWeight = targetWeight − band
maxWeight = targetWeight + band
```

Default:
- `band = ±5%` (configurable)

Effects:
- Prevents signal spam from drifting the portfolio
- Allows natural price movement
- Avoids constant rebalancing

---

## 6. Buy Permission Logic (Core Gate)

Every buy signal must pass allocation gating.

### Conditions (ALL required)
- Valid strategy signal
- Asset enabled in `assets.ts`
- `currentWeight < maxWeight`
- Available USDC > safety reserve
- Bot-level limits not exceeded (testing mode)

If any condition fails:
- Trade is blocked
- Signal is logged with reason
- No retry or queueing

---

## 7. Dynamic Position Sizing

Position size is capped by remaining allocation headroom.

Definitions:
```
currentValue = value of asset held
headroom = (maxWeight × totalValue) − currentValue
```

Final order size:
```
orderUsdc = min(
  strategyTradeLegUsdc,
  headroom,
  availableUsdc − reserve
)
```

Result:
- Full-size trades when underweight
- Smaller trades near cap
- Zero trades once cap reached

---

## 8. No Reserved Capital Rule

- USDC is shared across all assets
- No capital is locked to inactive assets
- If an asset has no signals for months:
  - Other assets may continue buying up to their caps

This prevents "silent asset blocking".

---

## 9. Multi-Bot Testing Mode (CURRENT SETUP)

During indicator/timeframe testing:

### Bot-Level Caps
Each bot may have:
- `BOT_MAX_DEPLOYED_USDC`
- OR `BOT_MAX_PORTFOLIO_PCT`

Purpose:
- Prevent chatty indicators from starving others
- Ensure fair forward-test results

### Final Gate (Testing Mode)
```
signal valid
AND botCap not exceeded
AND asset under max band
AND USDC reserve OK
→ trade allowed
```

---

## 10. Production Mode (Single Bot)

Once testing is complete:
- Remove bot-level caps
- Keep portfolio allocation logic unchanged

System simplifies to:
> Signals + Allocation-Gated Sizing

---

## 11. State & Concurrency

### State Files
- `state-{botId}.json` → strategy state only
- `portfolio-state.json` → allocations, balances, in-flight orders

### Concurrency Protection
- File or mutex lock around portfolio updates
- Prevents double-spend when multiple bots fire simultaneously

---

## 12. Logging & Observability

Every blocked or executed trade must log:
- Bot ID
- Asset
- Timeframe & strategy
- Signal type
- Current / target / max weight
- Headroom remaining
- Decision and reason

This makes allocation behavior auditable.

---

## 13. Acceptance Tests (Required)

The system is considered correct only if:

- Repeated signals stop at allocation cap
- Inactive assets do not block others
- Multiple bots cannot overspend USDC
- Restarting bots preserves allocation state
- Portfolio weights remain within bands over time

---

## 14. System Classification

This allocation system is a:

**Target-Weight, Band-Limited, Signal-Gated Spot Portfolio Engine**

Designed for:
- Long-term holding
- Signal-driven entries
- Minimal intervention
- Maximum robustness

---

## 15. Final Notes

This document is a **design contract**.

Bots must adapt to the allocation engine.
The allocation engine never adapts to bots.
