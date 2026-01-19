# Bug Report: btc-trader

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
