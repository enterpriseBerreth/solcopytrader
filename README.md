# COPYBOT — Solana Copytrade Bot

Monitors specified Solana wallets and copies their token buys/sells in real-time. Auto-seeds new profitable wallets and sends Telegram alerts after each trade exit.

## Features

- **Wallet Copy Trading** — Monitors up to 10 Solana wallets, copies their token swaps
- **Auto Wallet Seeding** — Discovers new wallets via co-buying patterns, auto-adds up to 10 total
- **Paper Trading** — $1,000 budget, $30 per trade, max 3 concurrent
- **Helius Enhanced Parsing** — Accurate swap detection via Helius Enhanced Transactions API
- **Telegram Alerts** — Detailed PNL reports sent after each trade exit
- **Safety Exits** — Emergency stop loss (-50%), max hold time (4h)
- **Crash Protection** — Graceful shutdown with Telegram error notifications

## Quick Start

```bash
npm install
copy env.template .env   # then edit .env with your keys
npm start
```

## Configuration

| Parameter | Value |
|-----------|-------|
| Budget | $1,000 USD |
| Trade Size | $30 per trade |
| Max Concurrent | 3 trades |
| Max Hold Time | 4 hours |
| Emergency SL | -50% |
| Max Wallets | 10 (3 starting + auto-seeded) |

## Starting Wallets

- `4nvNc7dDEqKKLM4Sr9Kgk3t1of6f8G66kT64VoC95LYh`
- `kiLogfWUXp7nby7Xi6R9t7u8ERQyRdAzg6wBjvuE49uA`
- `UEQxhkAVz71w2WBa9BYSoZrydhYNJaKmfNomoNs9E4t`

## Project Structure

```
src/
├── index.ts            Entry point
├── config.ts           Configuration
├── types.ts            TypeScript types
├── helius.ts           Helius API (tx parsing, price lookups)
├── wallet-monitor.ts   Wallet transaction polling
├── copy-trader.ts      Paper trading engine
├── wallet-seeder.ts    Auto wallet discovery
├── telegram.ts         Telegram alerts
└── logger.ts           Console logger
```

## Disclaimer

Educational and paper trading purposes only. Cryptocurrency trading involves substantial risk.
