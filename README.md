# btc-trader

Personal cryptocurrency trading bot built on the `trading-bot-platform` package. Trades on Solana via Jupiter DEX.

## Overview

This is a private trading application that uses the reusable `trading-bot-platform` library. It includes multiple trading strategies across different timeframes.

## Bots

| Bot | File | Strategy | Timeframe | Assets |
|-----|------|----------|-----------|--------|
| MFI Daily | `mfi-daily.ts` | MFI crossover | 1D | BTC (WBTC) |
| MFI 4H | `mfi-4h.ts` | MFI crossover | 4H | wETH, SOL, JUP |
| TCF2 | `tcf2.ts` | Trend Continuation Factor | 4H | wETH, SOL, JUP |
| KPSS | `kpss.ts` | Kase Permission Stochastic | 4H | wETH, SOL, JUP |
| TDFI | `tdfi.ts` | Trend Direction Force Index | 4H | wETH, SOL, JUP |
| DSS-MOM | `dssmom.ts` | DSS Averages of Momentum | 4H | wETH, SOL, JUP |

## Project Structure

```
btc-trader/
├── src/
│   ├── bots/           # Bot implementations
│   │   ├── mfi-daily.ts
│   │   ├── mfi-4h.ts
│   │   ├── tcf2.ts
│   │   ├── kpss.ts
│   │   ├── tdfi.ts
│   │   └── dssmom.ts
│   ├── config/         # Configuration loaders
│   │   ├── types.ts    # Config type definitions
│   │   ├── mfi-daily.ts
│   │   ├── mfi-4h.ts
│   │   ├── tcf2.ts
│   │   ├── kpss.ts
│   │   ├── tdfi.ts
│   │   ├── dssmom.ts
│   │   └── assets.ts   # Tradable assets config
│   ├── continuous/     # Continuous mode handlers
│   │   ├── daily.ts    # For 1D timeframe
│   │   └── 4h.ts       # For 1H/4H timeframes
│   ├── bot-runner.ts   # Universal bot launcher
│   ├── dashboard.ts    # Dashboard entry point
│   └── index.ts        # Main exports
├── dist/               # Compiled JavaScript
├── logs/               # Log files
├── systemd/            # Service files for Pi deployment
├── bots.json           # Bot registry for dashboard
├── .env                # Global environment (secrets)
├── .env.4h             # 4H MFI bot config
├── .env.tcf2           # TCF2 bot config
├── .env.kpss           # KPSS bot config
├── .env.tdfi           # TDFI bot config
├── .env.dssmom         # DSS-MOM bot config
└── state-*.json        # Bot state files
```

## Setup

### Prerequisites

- Node.js 20+
- `trading-bot-platform` package (linked locally or from npm)

### Installation

```bash
# Install dependencies
npm install

# Build
npm run build
```

### Environment Configuration

1. Copy `.env.example` to `.env` and fill in your secrets:

```bash
cp .env.example .env
```

2. Required variables in `.env`:
   - `SOLANA_RPC_URL` - Solana RPC endpoint
   - `WALLET_SECRET_KEY` - Your wallet's secret key (base58)
   - `USDC_MINT` - USDC token mint address
   - `WBTC_MINT` - WBTC mint (for daily bot)

3. Per-bot config files (`.env.4h`, `.env.tcf2`, etc.) override global settings

## Running Bots

### Single Execution

```bash
# Run MFI 4H bot once
BOT_ENV_FILE=.env.4h CONTINUOUS_MODE=false node dist/bots/mfi-4h.js

# Run TDFI bot once
BOT_ENV_FILE=.env.tdfi CONTINUOUS_MODE=false node dist/bots/tdfi.js
```

### Continuous Mode

```bash
# Run in continuous mode (24/7)
BOT_ENV_FILE=.env.4h node dist/bots/mfi-4h.js
```

### Using Bot Runner

```bash
# Via bot-runner (reads from bots.json)
node dist/bot-runner.js --bot-id 4h-mfi
```

### Dashboard API

```bash
node dist/dashboard.js
```

### Dashboard UI

The UI is a lightweight web app served by `ui-server` on port 5173.
Use the theme toggle in the top-right to switch between light and dark mode (preference is saved).

```bash
node dist/ui-server.js
```

By default it proxies `/api/*` to the dashboard API on port 3001. If you want
to point it somewhere else, set `DASHBOARD_API_URL`.

## Configuration

### Key Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PAPER_MODE` | Paper trading (no real trades) | `true` |
| `LIVE_TRADING_ENABLED` | Must be true for live trading | `false` |
| `CONTINUOUS_MODE` | Run 24/7 waiting for candles | `true` |
| `MFI_PERIOD` | MFI calculation period | `14` |
| `MFI_BUY_LEVEL` | MFI buy threshold | `20` (daily) / `40` (4H) |
| `MFI_SELL_LEVEL` | MFI sell threshold | `80` (daily) / `60` (4H) |
| `ATR_PERIOD` | ATR calculation period | `14` |
| `ATR_TP_MULT` | Take profit ATR multiplier | `1.5` |
| `ATR_TRAIL_MULT` | Trailing stop ATR multiplier | `3.0` |
| `TRADE_LEG_USDC` | USD per trade leg | `100` |
| `SLIPPAGE_BPS` | Max slippage in basis points | `50` |

### Assets Configuration

Edit `src/config/assets.ts` to modify tradable assets:

```typescript
export const DEFAULT_ASSETS: AssetConfig[] = [
  {
    symbol: 'wETH',
    name: 'Wrapped Ethereum',
    binanceSymbol: 'ETHUSDT',
    solanaMint: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
    tradeLegUsdc: 100,
    enabled: true,
  },
  // ... more assets
];
```

## Deployment (Pi 5)

### Copy to Pi

```bash
scp -r /path/to/btc-trader sav@192.168.68.20:/home/sav/
```

### Systemd Services

Install the bot service template:

```bash
sudo cp systemd/bot@.service /etc/systemd/system/
sudo systemctl daemon-reload
```

Start a bot:

```bash
sudo systemctl start bot@4h-mfi
sudo systemctl enable bot@4h-mfi
```

Service names map to bot IDs in `bots.json`:
`bot@btc-daily`, `bot@4h-mfi`, `bot@tcf2`, `bot@kpss`, `bot@tdfi`, `bot@dssmom`.
Avoid legacy names like `bot@4h-tcf2` or `bot@1d-mfi`.

Check status:

```bash
sudo systemctl status bot@4h-mfi
journalctl -u bot@4h-mfi -f
```

## Development

### Build

```bash
npm run build
```

### Project depends on

- `trading-bot-platform` - Core trading functionality (linked via `file:../trading-bot-platform`)

### TypeScript Configuration

Uses `Node16` module resolution for ESM compatibility with the platform package.

## File Locations

| File | Purpose |
|------|---------|
| `state-{botId}.json` | Persisted bot state (positions, last run) |
| `logs/bot-{botId}.log` | Bot execution logs |
| `logs/error-{botId}.log` | Error logs |
| `logs/csv/{botId}/` | Trade history CSV files |
| `bots.json` | Bot registry for dashboard |

## Safety Features

- **Paper Mode**: Default enabled, no real trades
- **Circuit Breaker**: Stops trading after consecutive losses
- **Slippage Protection**: Max slippage configurable
- **Min Balance Checks**: Won't trade below reserve levels
- **Two-Leg Positions**: TP leg + Runner leg with trailing stop

## Related

- `trading-bot-platform` - The reusable platform library
- `BTC_bot` - Original monolithic version (deprecated)
