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
| Moderate | 1 | Open |
| Low | 1 | Open |

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

**Status:** Open

**File:** `src/index.ts` (lines 22-28)
**Impact:** Unexpected console output when module is imported

```typescript
// These lines execute on import, not just on direct execution
console.log('Bot implementations available in src/bots/');
console.log('Run with: BOT_ENV_FILE=.env.4h node dist/bots/mfi-4h.js');
// ...
```

**Recommendation:** Wrap in a main-module check or move to a separate CLI entry point:

```typescript
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log('Bot implementations available in src/bots/');
  // ...
}
```

---

## Low Priority Issues

### BUG-003: Missing Error Handling on Directory Creation

**Status:** Open

**File:** `src/bots/mfi-4h.ts` (lines 86-89)
**Impact:** Unclear error message if data directory creation fails

```typescript
const dataDir = process.env.BOT_DATA_DIR || 'data';
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });  // No try-catch
}
```

**Recommendation:** Add error handling:

```typescript
const dataDir = process.env.BOT_DATA_DIR || 'data';
if (!fs.existsSync(dataDir)) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
  } catch (err) {
    logger.error(`Failed to create data directory: ${dataDir}`, err);
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

## Recommended Fix Order

1. ~~**BUG-001** - Fix immediately, blocks all affected bots from running~~ **DONE**
2. **BUG-002** - Fix when convenient, cosmetic issue
3. **BUG-003** - Fix when convenient, edge case

---

## Verification Steps

After fixing BUG-001, verify with:

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
