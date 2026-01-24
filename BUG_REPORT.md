# Bug Report: btc-trader

**Date:** 2026-01-24
**Reviewer:** Claude Code (Opus 4.5)

---

## New Issues (2026-01-24)

Code review identified **3 critical**, **3 high**, and **5 medium** severity issues.

### CRITICAL

#### BUG-009: Hard-coded Zeros in Journal Cycle End Events

**Severity:** Critical
**Files:** `src/bots/mfi-4h.ts:641-648`, `src/bots/tcf2.ts:536-538`, `src/bots/kpss.ts:518-520`, `src/bots/tdfi.ts:517-519`, `src/bots/dssmom.ts:518-520`, `src/bots/mfi-daily.ts:607-609`
**Impact:** Forward-testing metrics are completely wrong. The journal always records 0 positions opened/closed/trimmed regardless of actual activity.
**Status:** Closed

**Current Code:**
```typescript
journal.cycleEnd(cycleEndMarket, {
  assetsProcessed: assets.length,
  signalsGenerated: signals.length,
  positionsOpened: 0,  // ALWAYS ZERO
  positionsClosed: 0,  // ALWAYS ZERO
  runnersTrimmed: 0,   // ALWAYS ZERO
  cycleDurationMs: Date.now() - cycleStartTime,
});
```

**Intended Fix:** Track metrics during signal processing loop:
```typescript
let positionsOpened = 0;
let positionsClosed = 0;
let runnersTrimmed = 0;

// In signal processing loop:
if (newLegs && newLegs.length > 0) positionsOpened++;
positionsClosed += closedLegs.length;
if (trimmedLegs && trimmedLegs.length > 0) runnersTrimmed++;

// Then pass actual values to journal.cycleEnd()
```

---

#### BUG-010: Missing `await` on Async Broker Methods

**Severity:** Critical
**Files:** `src/bots/mfi-4h.ts:469,572`, `src/bots/tcf2.ts:423,526`, `src/bots/kpss.ts:418,511`, `src/bots/tdfi.ts:417,510`, `src/bots/dssmom.ts:418,511`
**Impact:** Race conditions in trade execution. Trades may execute out of order, state may be corrupted, potential money loss. The CLAUDE.md explicitly warns about this.
**Status:** Closed

**Current Code:**
```typescript
const newLegs = broker.openPosition(brokerSignal, candle);      // Missing await
const updatedLegs = broker.trimRunners(runnerLegs, candle);     // Missing await
```

**Intended Fix:** Add `await` keyword:
```typescript
const newLegs = await broker.openPosition(brokerSignal, candle);
const updatedLegs = await broker.trimRunners(runnerLegs, candle);
```

---

#### BUG-011: Unsafe Type Casting for Broker Config

**Severity:** Critical
**Files:** `src/bots/mfi-4h.ts:109-113`, `src/bots/tcf2.ts:105-109`, `src/bots/kpss.ts:105-109`, `src/bots/tdfi.ts:105-109`, `src/bots/dssmom.ts:105-109`
**Impact:** Per-asset trade leg sizing may fail silently if broker structure changes. Uses `as unknown as {...}` to bypass TypeScript.
**Status:** Closed

**Current Code:**
```typescript
function setBrokerTradeLegUsdc(broker: PaperBroker | LiveBroker, tradeLegUsdc: number): void {
  const mutable = broker as unknown as { config?: { tradeLegUsdc?: number } };
  if (mutable.config) {
    mutable.config.tradeLegUsdc = tradeLegUsdc;
  }
}
```

**Intended Fix:** Add runtime validation or use platform API if available:
```typescript
function setBrokerTradeLegUsdc(broker: PaperBroker | LiveBroker, tradeLegUsdc: number): void {
  const mutable = broker as unknown as { config?: { tradeLegUsdc?: number } };
  if (mutable.config && typeof mutable.config.tradeLegUsdc === 'number') {
    mutable.config.tradeLegUsdc = tradeLegUsdc;
  } else {
    log.warn(`Could not set tradeLegUsdc on broker - config structure mismatch`);
  }
}
```

---

### HIGH

#### BUG-012: Missing Error Handling on closeLeg

**Severity:** High
**File:** `src/bots/mfi-daily.ts:214`
**Impact:** If broker fails to close a leg, the bot continues as if it succeeded. Orphaned positions possible.
**Status:** Closed

**Current Code:**
```typescript
for (const leg of closedLegs) {
  log.info(`${asset.symbol}: ${leg.type} leg closed - ${leg.closeReason}`);
  await broker.closeLeg(leg, latestCandle, leg.closeReason || 'Unknown');
  csvLogger.logPositionLegClosure(leg, asset.symbol, config.paperMode ? 'PAPER' : 'LIVE');
}
```

**Intended Fix:** Add try-catch with logging:
```typescript
for (const leg of closedLegs) {
  log.info(`${asset.symbol}: ${leg.type} leg closed - ${leg.closeReason}`);
  try {
    await broker.closeLeg(leg, latestCandle, leg.closeReason || 'Unknown');
    csvLogger.logPositionLegClosure(leg, asset.symbol, config.paperMode ? 'PAPER' : 'LIVE');
  } catch (err) {
    log.error(`${asset.symbol}: Failed to close ${leg.type} leg ${leg.id}`, err);
    // Consider: should we continue or abort the cycle?
  }
}
```

---

#### BUG-013: Off-by-One in Candle Index (4H Bots)

**Severity:** High
**Files:** `src/bots/mfi-4h.ts:142-146`, similar in tcf2, kpss, tdfi, dssmom
**Impact:** Analysis may be one candle behind. Daily bot uses `candles.length - 1`, 4H bots use `candles.length - 2`.
**Status:** Closed

**Current Code:**
```typescript
const currentIndex = candles.length - 2; // Last COMPLETED candle
const currentCandle = candles[currentIndex];
```

**Fix Applied:** Clarified intent with comment in all 4H bots to keep `-2` (skip potentially incomplete candle):
```typescript
// Use -2 to get the last COMPLETED candle (latest candle may be incomplete mid-bar)
const currentIndex = candles.length - 2;
```

---

#### BUG-014: Dashboard Route Injection Fragility

**Severity:** High
**File:** `src/dashboard.ts:204-221`
**Impact:** Custom routes may not work if platform changes `notFoundHandler` name.
**Status:** Closed

**Current Code:**
```typescript
const notFoundIndex = stack.findIndex(
  (layer: any) => layer.name === 'notFoundHandler'
);
if (notFoundIndex !== -1) {
  const newLayers = stack.splice(stackLengthBefore);
  stack.splice(notFoundIndex, 0, ...newLayers);
} else {
  console.log('Custom routes added (404 handler not found)');
}
```

**Fix Applied:** Added warning log to flag missing 404 handler and guide future adjustments:
```typescript
if (notFoundIndex !== -1) {
  const newLayers = stack.splice(stackLengthBefore);
  stack.splice(notFoundIndex, 0, ...newLayers);
} else {
  console.warn('WARNING: 404 handler not found - custom routes may not work correctly');
  console.warn('Consider updating route injection logic if platform changed');
}
```

---

### MEDIUM

#### BUG-015: No State Flush on Graceful Shutdown

**Severity:** Medium
**Files:** All bot files
**Impact:** If bot crashes between cycles, latest state changes are lost.
**Status:** Closed

**Fix Applied:** Added SIGINT/SIGTERM handlers to flush state before exit:
```typescript
process.on('SIGINT', async () => {
  log.info('Received SIGINT, saving state before exit...');
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  process.exit(0);
});
```

---

#### BUG-016: Timing Edge Cases in Continuous Mode

**Severity:** Medium
**File:** `src/continuous/4h.ts:92`
**Impact:** If bot cycle takes longer than windowMs (30-60 min), next cycle is skipped.
**Status:** Closed

**Fix Applied:** Added catch-up execution with warning when the execution window is missed.

---

#### BUG-017: Empty Asset List Not Fatal

**Severity:** Medium
**Files:** All bot files
**Impact:** Bot runs but does nothing if no assets configured. User doesn't realize it's broken.
**Status:** Closed

**Current Code:**
```typescript
if (assets.length === 0) {
  log.error('No enabled assets found for this bot');
  return;  // Returns silently
}
```

**Fix Applied:** Exit with non-zero code when no assets are enabled:
```typescript
if (assets.length === 0) {
  log.error('No enabled assets found for this bot - exiting');
  process.exit(1);
}
```

---

#### BUG-018: No Retry on Binance Fetch Failure

**Severity:** Medium
**Files:** All bot files in `processAsset` function
**Impact:** Single network hiccup stops entire bot cycle.
**Status:** Closed

**Fix Applied:** Added retry logic with exponential backoff (3 attempts) around candle fetches.

---

#### BUG-019: No Wallet Validation Before Live Trading

**Severity:** Medium
**Files:** All bot files when initializing LiveBroker
**Impact:** Silent trade failures if wallet is invalid/empty.
**Status:** Closed

**Fix Applied:** Added startup balance check in live mode (USDC reserve):
```typescript
if (!config.paperMode) {
  const balances = await getAllBalances(connection, walletPublicKey, config.usdcMint, config.cbBtcMint, config.wbtcMint);
  if (balances.usdc < config.minUsdcReserve) {
    log.error(`Insufficient USDC balance: ${balances.usdc} USDC (minimum reserve: ${config.minUsdcReserve})`);
    process.exit(1);
  }
}
```

---

## New Issues (2026-01-24)

Code review identified **1 high** and **1 medium** severity issue.

### HIGH

#### BUG-020: Live Bots Do Not Execute On-Chain Closes

**Severity:** High
**Files:** `src/bots/mfi-4h.ts`, `src/bots/tcf2.ts`, `src/bots/kpss.ts`, `src/bots/tdfi.ts`, `src/bots/dssmom.ts`
**Impact:** In live mode, TP/trailing-stop closures are only recorded in state. The broker is never asked to close legs on-chain, so real positions can remain open while state says closed.
**Status:** Closed

**Current Code (pattern):**
```typescript
const updatedLegs = updatePositions(...);
const closedLegs = updatedLegs.filter(...); // only logs/CSV/journal
updateAssetPositions(state, asset.symbol, updatedLegs);
```

**Fix Applied:** Added broker close calls for newly closed legs and guarded with error logging during close attempts.

---

### MEDIUM

#### BUG-021: positionsClosed Metrics Never Incremented

**Severity:** Medium
**Files:** `src/bots/mfi-4h.ts`, `src/bots/tcf2.ts`, `src/bots/kpss.ts`, `src/bots/tdfi.ts`, `src/bots/dssmom.ts`, `src/bots/mfi-daily.ts`
**Impact:** Journal cycle summaries always report zero closed positions, even when legs are closed.
**Status:** Closed

**Current Code (pattern):**
```typescript
let positionsClosed = 0;
// positionsClosed never updated
journal.cycleEnd(..., { positionsClosed, ... });
```

**Fix Applied:** Incremented `positionsClosed` when newly closed legs are detected per cycle.

---

## Previous Issues (2026-01-21)

**Date:** 2026-01-21
**Reviewer:** Codex

---

## New Issues (2026-01-21)

Code review identified **2 high**, **2 moderate**, and **1 low** severity issues.

### BUG-004: Unbounded Recursion in 4H Continuous Mode

**Severity:** High  
**File:** `src/continuous/4h.ts`  
**Impact:** Long-running 4H bots can eventually hit a stack overflow or memory growth because `checkAndExecute()` recursively `await`s itself without unwinding the call stack.
**Status:** **FIXED** (2026-01-21)

### BUG-005: 4H Bots Ignore Live Trading Flags

**Severity:** High  
**Files:** `src/bots/mfi-4h.ts`, `src/bots/tcf2.ts`, `src/bots/kpss.ts`, `src/bots/tdfi.ts`, `src/bots/dssmom.ts`  
**Impact:** Even with `PAPER_MODE=false` and `LIVE_TRADING_ENABLED=true`, these bots always use `PaperBroker`, so they never execute live orders.
**Status:** **FIXED** (2026-01-21)

### BUG-006: Daily Bot Ignores Per-Bot Env File

**Severity:** Moderate  
**File:** `src/config/mfi-daily.ts`  
**Impact:** `BOT_ENV_FILE` (e.g., `.env.btc-daily`) is never loaded, so per-bot overrides are silently ignored.
**Status:** **FIXED** (2026-01-21)

### BUG-007: MFI 4H State File Name Mismatch in Direct Runs

**Severity:** Moderate  
**File:** `src/bots/mfi-4h.ts`  
**Impact:** Direct runs default to `state-4h.json` while `bots.json` and `bot-runner` use `state-4h-mfi.json`, causing inconsistent state and potential duplicate trades.
**Status:** **FIXED** (2026-01-21)

### BUG-008: Hardcoded Trade Size in 4H Bots

**Severity:** Low  
**Files:** `src/bots/mfi-4h.ts`, `src/bots/tcf2.ts`, `src/bots/kpss.ts`, `src/bots/tdfi.ts`, `src/bots/dssmom.ts`  
**Impact:** `PaperBroker` is initialized with `tradeLegUsdc: 100`, ignoring `assets.json` per-asset sizing.
**Status:** **FIXED** (2026-01-21)

---

**Date:** 2026-01-20
**Reviewer:** Claude Code
**Commit:** 2be4f23 (main)

---

## Summary

Code review identified **10 critical import errors**, **1 moderate design issue**, and **1 low-priority error handling gap**.

| Severity | Count | Status |
|----------|-------|--------|
| Critical | 10 | **FIXED** |
| Moderate | 1 | **FIXED** |
| Low | 1 | **FIXED** |

---

## Critical Issues

### BUG-001: Missing `.js` Extensions in Local Imports

**Status:** **FIXED** (2026-01-20)

**Impact:** Runtime failure - bots will not start
**Root Cause:** TypeScript Node16 module resolution requires explicit `.js` extensions on relative imports

The following files had imports that would fail at runtime:

#### src/bots/mfi-daily.ts

| Line | Before | After |
|------|--------|-------|
| 27 | `'../config/mfi-daily'` | `'../config/mfi-daily.js'` |

#### src/bots/tcf2.ts

| Line | Before | After |
|------|--------|-------|
| 32 | `'../config/tcf2'` | `'../config/tcf2.js'` |
| 33 | `'../config/assets'` | `'../config/assets.js'` |

#### src/bots/kpss.ts

| Line | Before | After |
|------|--------|-------|
| 32 | `'../config/kpss'` | `'../config/kpss.js'` |
| 33 | `'../config/assets'` | `'../config/assets.js'` |

#### src/bots/tdfi.ts

| Line | Before | After |
|------|--------|-------|
| 32 | `'../config/tdfi'` | `'../config/tdfi.js'` |
| 33 | `'../config/assets'` | `'../config/assets.js'` |

#### src/bots/dssmom.ts

| Line | Before | After |
|------|--------|-------|
| 32 | `'../config/dssmom'` | `'../config/dssmom.js'` |
| 33 | `'../config/assets'` | `'../config/assets.js'` |

#### src/continuous/daily.ts

| Line | Before | After |
|------|--------|-------|
| 8 | `'../config/types'` | `'../config/types.js'` |

**Note:** `src/bots/mfi-4h.ts` was already correct and used as reference.

---

## Moderate Issues

### BUG-002: Side Effects in Module Entry Point

**Status:** **FIXED** (2026-01-20)

**File:** `src/index.ts` (lines 22-31)
**Impact:** Unexpected console output when module is imported

**Fix Applied:** Wrapped console output in `require.main === module` check:

```typescript
// Only show usage when run directly (not imported as a module)
if (require.main === module) {
  console.log('btc-trader - Personal Trading Bot');
  // ...
}
```

---

## Low Priority Issues

### BUG-003: Missing Error Handling on Directory Creation

**Status:** **FIXED** (2026-01-20)

**File:** `src/bots/mfi-4h.ts` (lines 87-95)
**Impact:** Unclear error message if data directory creation fails

**Fix Applied:** Added try-catch with proper error logging:

```typescript
const dataDir = process.env.BOT_DATA_DIR || 'data';
if (!fs.existsSync(dataDir)) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
  } catch (err) {
    const log = getMFI4HLogger();
    log.error(`Failed to create data directory: ${dataDir}`, err);
    throw new Error(`Cannot create data directory: ${dataDir}`);
  }
}
```

---

## Files Verified as Correct

The following files were reviewed and have no issues:

- `src/bots/mfi-4h.ts` - Correct `.js` extensions
- `src/config/*.ts` - All config files properly structured
- `src/continuous/4h.ts` - Correct imports and logic
- `src/bot-runner.ts` - Correct implementation
- `src/dashboard.ts` - Correct implementation

---

## All Issues Resolved

All identified bugs have been fixed:

1. ~~**BUG-001** - Missing `.js` extensions~~ **DONE**
2. ~~**BUG-002** - Side effects in index.ts~~ **DONE**
3. ~~**BUG-003** - Missing error handling~~ **DONE**

---

## Verification Steps

Verify fixes with:

```bash
# Build
npm run build

# Test each bot in paper mode
BOT_ENV_FILE=.env.4h CONTINUOUS_MODE=false PAPER_MODE=true node dist/bots/mfi-4h.js
BOT_ENV_FILE=.env.tcf2 CONTINUOUS_MODE=false PAPER_MODE=true node dist/bots/tcf2.js
BOT_ENV_FILE=.env.kpss CONTINUOUS_MODE=false PAPER_MODE=true node dist/bots/kpss.js
BOT_ENV_FILE=.env.tdfi CONTINUOUS_MODE=false PAPER_MODE=true node dist/bots/tdfi.js
BOT_ENV_FILE=.env.dssmom CONTINUOUS_MODE=false PAPER_MODE=true node dist/bots/dssmom.js
CONTINUOUS_MODE=false PAPER_MODE=true node dist/bots/mfi-daily.js
```
