import { CONFIG } from './config.js';
import { WalletMonitor } from './wallet-monitor.js';
import { CopyTrader } from './copy-trader.js';
import { WalletSeeder } from './wallet-seeder.js';
import { TelegramAlert } from './telegram.js';
import { log } from './logger.js';

const MODULE = 'COPYBOT';
const STATUS_INTERVAL_MS = 60_000;
const PRUNE_INTERVAL_MS = 10 * 60_000;
const MST_OFFSET_HOURS = -7; // MST = UTC-7 (no daylight saving)

async function main() {
  log.banner('COPYBOT — Solana Copytrade Bot');

  console.log(`  Mode:              ${CONFIG.PAPER_TRADE ? 'PAPER TRADE' : 'LIVE TRADING'}`);
  console.log(`  Budget:            $${CONFIG.STARTING_BUDGET_USD}`);
  console.log(`  Trade Size:        $${CONFIG.TRADE_SIZE_USD}`);
  console.log(`  Max Concurrent:    ${CONFIG.MAX_CONCURRENT_TRADES}`);
  console.log(`  Wallets:           ${CONFIG.WATCHED_WALLETS.length} starting`);
  console.log(`  Max Wallets:       ${CONFIG.MAX_WATCHED_WALLETS} (auto-seed enabled)`);
  console.log(`  Poll Interval:     ${CONFIG.WALLET_POLL_INTERVAL_MS / 1000}s`);
  console.log(`  Max Hold:          ${CONFIG.MAX_HOLD_TIME_MINUTES}m`);
  console.log(`  Emergency SL:      ${CONFIG.EMERGENCY_STOP_LOSS_PCT}%`);
  const rpcHost = new URL(CONFIG.SOLANA_RPC_URL).hostname;
  console.log(`  RPC:               ${rpcHost}`);
  console.log(`  Helius API Key:    ${CONFIG.HELIUS_API_KEY ? CONFIG.HELIUS_API_KEY.slice(0, 8) + '...' : 'NOT SET'}`);
  console.log('');

  if (!CONFIG.HELIUS_API_KEY) {
    log.error(MODULE, 'HELIUS_API_KEY is required. Set via SOLANA_RPC_URL or HELIUS_API_KEY env var.');
    process.exit(1);
  }

  if (!CONFIG.PAPER_TRADE) {
    log.warn(MODULE, '*** LIVE TRADING MODE — Real money at risk! ***');
    log.warn(MODULE, 'Press Ctrl+C within 10 seconds to abort...');
    await sleep(10_000);
  }

  const telegram = new TelegramAlert();
  const trader = new CopyTrader(telegram);
  const monitor = new WalletMonitor(CONFIG.WATCHED_WALLETS);
  const seeder = new WalletSeeder(monitor);

  // Wire: monitor -> trader + seeder
  monitor.onSwapDetected = async (swap) => {
    try {
      if (swap.direction === 'BUY') seeder.recordBuy(swap.tokenMint);
      await trader.handleSwap(swap);
    } catch (err) {
      log.error(MODULE, `Error handling swap: ${err}`);
    }
  };

  // Start all systems
  monitor.start();
  trader.startPriceMonitor();
  seeder.start();

  await telegram.sendStartedAlert(monitor.walletCount);

  const statusInterval = setInterval(() => {
    trader.printStatus();
    log.info(MODULE, `Wallets: ${monitor.walletCount}/${CONFIG.MAX_WATCHED_WALLETS}`);
  }, STATUS_INTERVAL_MS);

  const pruneInterval = setInterval(() => {
    monitor.pruneSeenSignatures();
  }, PRUNE_INTERVAL_MS);

  // Schedule daily wallet ranking at 12:00 AM MST
  const dailyReportTimer = scheduleDailyReport(async () => {
    log.info(MODULE, 'Sending daily wallet performance report...');
    const wallets = trader.getWalletPerformance();
    await telegram.sendDailyRanking({
      wallets,
      totalPnl: trader.totalPnl,
      budgetRemaining: trader.budgetRemaining,
      walletCount: monitor.walletCount,
    });
    log.success(MODULE, 'Daily report sent');
  });

  // Graceful shutdown
  const shutdown = async (reason: string) => {
    log.info(MODULE, 'Shutting down...');
    monitor.stop();
    trader.stopPriceMonitor();
    seeder.stop();
    clearInterval(statusInterval);
    clearInterval(pruneInterval);
    clearTimeout(dailyReportTimer);

    trader.printStatus();
    await telegram.sendStoppedAlert(reason);

    log.banner('COPYBOT — Shutdown Complete');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('Manual stop (SIGINT)'));
  process.on('SIGTERM', () => shutdown('Process terminated (SIGTERM)'));

  process.on('uncaughtException', async (err) => {
    log.error(MODULE, `Uncaught exception: ${err.message}`);
    log.error(MODULE, err.stack ?? '');
    try { await telegram.sendStoppedAlert(`Crash: ${err.message}`); } catch (_) { /* best-effort */ }
  });
  process.on('unhandledRejection', async (reason) => {
    log.error(MODULE, `Unhandled rejection: ${reason}`);
    try { await telegram.sendStoppedAlert(`Crash: unhandled rejection — ${reason}`); } catch (_) { /* best-effort */ }
  });

  log.success(MODULE, 'All systems online — monitoring wallets for trades...');

  await new Promise(() => {});
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Returns ms until next 12:00 AM MST (UTC-7)
function msUntilMidnightMST(): number {
  const now = new Date();
  // Current time in MST
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60_000;
  const mstMs = utcMs + MST_OFFSET_HOURS * 3600_000;
  const mstNow = new Date(mstMs);

  // Next midnight MST
  const nextMidnight = new Date(mstNow);
  nextMidnight.setHours(24, 0, 0, 0); // midnight of next day

  const mstMidnightUtc = nextMidnight.getTime() - MST_OFFSET_HOURS * 3600_000 - now.getTimezoneOffset() * 60_000;
  return mstMidnightUtc - now.getTime();
}

function scheduleDailyReport(callback: () => Promise<void>): ReturnType<typeof setTimeout> {
  const ms = msUntilMidnightMST();
  const hrs = (ms / 3600_000).toFixed(1);
  log.info('SCHEDULER', `Daily report scheduled — next in ${hrs}h (12:00 AM MST)`);

  return setTimeout(async function fire() {
    try {
      await callback();
    } catch (err) {
      log.error('SCHEDULER', `Daily report error: ${err}`);
    }
    // Reschedule for next midnight
    const nextMs = msUntilMidnightMST();
    const nextHrs = (nextMs / 3600_000).toFixed(1);
    log.info('SCHEDULER', `Next daily report in ${nextHrs}h`);
    setTimeout(fire, nextMs);
  }, ms);
}

main().catch(async (err) => {
  log.error(MODULE, `Fatal error: ${err}`);
  try {
    const telegram = new TelegramAlert();
    await telegram.sendStoppedAlert(`Fatal: ${err}`);
  } catch (_) { /* best-effort */ }
  process.exit(1);
});
