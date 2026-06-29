import { CONFIG } from './config.js';
import { WatchedWallet, DetectedSwap } from './types.js';
import { getRecentSignatures, parseTransactions, extractSwap, getTokenInfo } from './helius.js';
import { log } from './logger.js';

const MODULE = 'MONITOR';

export class WalletMonitor {
  private wallets: Map<string, WatchedWallet> = new Map();
  private seenSignatures: Set<string> = new Set();
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private initialScanDone: Set<string> = new Set();

  onSwapDetected: ((swap: DetectedSwap) => void) | null = null;

  constructor(walletAddresses: string[]) {
    for (const addr of walletAddresses) {
      this.addWallet(addr, 'manual');
    }
  }

  addWallet(address: string, source: 'manual' | 'seeded'): boolean {
    if (this.wallets.has(address)) return false;
    if (this.wallets.size >= CONFIG.MAX_WATCHED_WALLETS) {
      log.warn(MODULE, `Cannot add wallet — max ${CONFIG.MAX_WATCHED_WALLETS} reached`);
      return false;
    }

    const label = `${address.slice(0, 4)}...${address.slice(-4)}`;
    this.wallets.set(address, {
      address, label, addedAt: Date.now(), source,
      stats: { tradesDetected: 0, tradesCopied: 0, totalPnlUsd: 0, winCount: 0, lossCount: 0 },
    });

    log.success(MODULE, `Watching wallet: ${label} (${source})`);
    return true;
  }

  getWallet(address: string): WatchedWallet | undefined {
    return this.wallets.get(address);
  }

  getWalletLabel(address: string): string {
    return this.wallets.get(address)?.label || address.slice(0, 8);
  }

  get walletCount(): number {
    return this.wallets.size;
  }

  get watchedAddresses(): string[] {
    return Array.from(this.wallets.keys());
  }

  start(): void {
    log.info(MODULE, `Starting wallet monitor — ${this.wallets.size} wallets, polling every ${CONFIG.WALLET_POLL_INTERVAL_MS / 1000}s`);
    this.pollAllWallets();
    this.pollInterval = setInterval(() => this.pollAllWallets(), CONFIG.WALLET_POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    log.info(MODULE, 'Wallet monitor stopped');
  }

  private async pollAllWallets(): Promise<void> {
    for (const wallet of this.wallets.values()) {
      try {
        await this.pollWallet(wallet);
      } catch (err) {
        log.error(MODULE, `Error polling ${wallet.label}: ${err}`);
      }
    }
  }

  private async pollWallet(wallet: WatchedWallet): Promise<void> {
    const sigs = await getRecentSignatures(wallet.address, CONFIG.MAX_SIGS_PER_POLL);
    if (sigs.length === 0) return;

    // First scan: mark existing txs as seen (don't copy old trades)
    if (!this.initialScanDone.has(wallet.address)) {
      for (const sig of sigs) this.seenSignatures.add(sig.signature);
      this.initialScanDone.add(wallet.address);
      log.info(MODULE, `${wallet.label} — Initial scan done, marked ${sigs.length} existing txs`);
      return;
    }

    const newSigs = sigs.filter(s => !this.seenSignatures.has(s.signature));
    if (newSigs.length === 0) return;

    for (const sig of newSigs) this.seenSignatures.add(sig.signature);
    log.info(MODULE, `${wallet.label} — ${newSigs.length} new transaction(s)`);

    const signatures = newSigs.map(s => s.signature);
    for (let i = 0; i < signatures.length; i += CONFIG.TX_PARSE_BATCH_SIZE) {
      const batch = signatures.slice(i, i + CONFIG.TX_PARSE_BATCH_SIZE);
      const parsed = await parseTransactions(batch);

      for (const tx of parsed) {
        const swap = extractSwap(tx, wallet.address, wallet.label);
        if (!swap) continue;

        const tokenInfo = await getTokenInfo(swap.tokenMint);
        swap.tokenSymbol = tokenInfo.symbol;
        swap.tokenName = tokenInfo.name;
        swap.priceUsd = tokenInfo.priceUsd;

        wallet.stats.tradesDetected++;

        log.trade(
          MODULE,
          `${wallet.label} ${swap.direction} ${swap.tokenSymbol} | ` +
          `${swap.solAmount.toFixed(4)} SOL | Price: $${fmtPrice(swap.priceUsd)} | ` +
          `Sig: ${swap.signature.slice(0, 12)}...`
        );

        this.onSwapDetected?.(swap);
      }
    }
  }

  pruneSeenSignatures(maxSize: number = 10_000): void {
    if (this.seenSignatures.size > maxSize) {
      const arr = Array.from(this.seenSignatures);
      const toRemove = arr.slice(0, arr.length - maxSize);
      for (const sig of toRemove) this.seenSignatures.delete(sig);
      log.info(MODULE, `Pruned ${toRemove.length} old signatures`);
    }
  }
}

function fmtPrice(price: number): string {
  if (price === 0) return 'unknown';
  if (price < 0.00001) return price.toExponential(4);
  if (price < 0.01) return price.toFixed(8);
  if (price < 1) return price.toFixed(6);
  return price.toFixed(4);
}
