import { CONFIG } from './config.js';
import { BotState, CopyPosition, DetectedSwap } from './types.js';
import { getJupiterPrices } from './helius.js';
import { TelegramAlert } from './telegram.js';
import { log } from './logger.js';

const MODULE = 'TRADER';

export class CopyTrader {
  private state: BotState;
  private telegram: TelegramAlert;
  private priceInterval: ReturnType<typeof setInterval> | null = null;
  // Track which wallets have signaled a buy for each token — reject if multiple wallets buy the same token
  private tokenBuyerMap: Map<string, string> = new Map(); // tokenMint → first walletAddress that bought it

  constructor(telegram: TelegramAlert) {
    this.telegram = telegram;
    this.state = {
      budgetRemaining: CONFIG.STARTING_BUDGET_USD,
      totalPnl: 0,
      tradesExecuted: 0,
      positions: new Map(),
      closedPositions: [],
      startTime: Date.now(),
      wins: 0,
      losses: 0,
    };
  }

  get openPositionCount(): number {
    return this.state.positions.size;
  }

  canTrade(): boolean {
    return (
      this.openPositionCount < CONFIG.MAX_CONCURRENT_TRADES &&
      this.state.budgetRemaining >= CONFIG.TRADE_SIZE_USD
    );
  }

  hasPosition(tokenMint: string): boolean {
    return this.state.positions.has(tokenMint);
  }

  // ── Handle detected swap ──

  async handleSwap(swap: DetectedSwap): Promise<void> {
    if (swap.direction === 'BUY') {
      await this.handleBuy(swap);
    } else {
      await this.handleSell(swap);
    }
  }

  private async handleBuy(swap: DetectedSwap): Promise<void> {
    // Check if another watched wallet already bought this token — only unique-per-wallet buys allowed
    const existingBuyer = this.tokenBuyerMap.get(swap.tokenMint);
    if (existingBuyer && existingBuyer !== swap.walletAddress) {
      log.info(MODULE, `${swap.walletLabel} bought ${swap.tokenSymbol} but another wallet already bought it — skipping (unique-per-wallet rule)`);
      return;
    }

    if (this.hasPosition(swap.tokenMint)) {
      log.info(MODULE, `Already holding ${swap.tokenSymbol} — skipping duplicate buy`);
      return;
    }

    if (!this.canTrade()) {
      log.warn(MODULE, `Cannot trade — ${this.openPositionCount}/${CONFIG.MAX_CONCURRENT_TRADES} slots, $${this.state.budgetRemaining.toFixed(2)} budget`);
      return;
    }

    const sizeUsd = CONFIG.TRADE_SIZE_USD;
    const capitalBefore = this.state.budgetRemaining;

    let priceUsd = swap.priceUsd;
    if (priceUsd <= 0) {
      const prices = await getJupiterPrices([swap.tokenMint]);
      priceUsd = prices.get(swap.tokenMint) || 0;
    }

    this.state.budgetRemaining -= sizeUsd;

    const position: CopyPosition = {
      id: `${swap.tokenMint}-${Date.now()}`,
      copiedWallet: swap.walletAddress,
      copiedWalletLabel: swap.walletLabel,
      tokenMint: swap.tokenMint,
      tokenSymbol: swap.tokenSymbol,
      tokenName: swap.tokenName,
      entryPriceUsd: priceUsd,
      currentPriceUsd: priceUsd,
      exitPriceUsd: 0,
      sizeUsd,
      capitalBeforeBuy: capitalBefore,
      entryTime: Date.now(),
      exitTime: 0,
      status: 'open',
      pnlUsd: 0,
      pnlPct: 0,
      exitReason: '',
    };

    this.state.positions.set(swap.tokenMint, position);
    this.tokenBuyerMap.set(swap.tokenMint, swap.walletAddress);
    this.state.tradesExecuted++;

    log.trade(
      MODULE,
      `COPY BUY ${swap.tokenSymbol} | Copied: ${swap.walletLabel} | ` +
      `Size: $${sizeUsd.toFixed(2)} | Price: $${fmtPrice(priceUsd)} | ` +
      `Budget: $${this.state.budgetRemaining.toFixed(2)}`
    );
  }

  private async handleSell(swap: DetectedSwap): Promise<void> {
    const position = this.state.positions.get(swap.tokenMint);
    if (!position) {
      log.info(MODULE, `${swap.walletLabel} sold ${swap.tokenSymbol} but we have no position — ignoring`);
      return;
    }

    if (position.copiedWallet !== swap.walletAddress) {
      log.info(MODULE, `${swap.walletLabel} sold ${swap.tokenSymbol} but we copied ${position.copiedWalletLabel} — ignoring`);
      return;
    }

    await this.closePosition(position, `Copied exit from ${swap.walletLabel}`);
  }

  // ── Close position ──

  private async closePosition(position: CopyPosition, reason: string): Promise<void> {
    const currentPrice = position.currentPriceUsd;
    const entryPrice = position.entryPriceUsd;

    let pnlPct = 0;
    if (entryPrice > 0) {
      pnlPct = ((currentPrice - entryPrice) / entryPrice) * 100;
    }
    const pnlUsd = position.sizeUsd * (pnlPct / 100);
    const proceeds = position.sizeUsd + pnlUsd;

    position.exitPriceUsd = currentPrice;
    position.exitTime = Date.now();
    position.status = 'closed';
    position.pnlUsd = pnlUsd;
    position.pnlPct = pnlPct;
    position.exitReason = reason;

    this.state.budgetRemaining += proceeds;
    this.state.totalPnl += pnlUsd;

    if (pnlUsd >= 0) this.state.wins++;
    else this.state.losses++;

    this.state.positions.delete(position.tokenMint);
    this.tokenBuyerMap.delete(position.tokenMint);
    this.state.closedPositions.push(position);

    const holdTime = formatHoldTime(position.exitTime - position.entryTime);
    const sign = pnlUsd >= 0 ? '+' : '';

    log.trade(
      MODULE,
      `COPY SELL ${position.tokenSymbol} | PNL: ${sign}$${pnlUsd.toFixed(2)} (${sign}${pnlPct.toFixed(2)}%) | ` +
      `Reason: ${reason} | Hold: ${holdTime}`
    );

    await this.telegram.sendTradeAlert({
      copiedWallet: position.copiedWalletLabel,
      tokenName: `${position.tokenSymbol} (${position.tokenName})`,
      capitalBeforeBuy: position.capitalBeforeBuy,
      capitalAfterSell: this.state.budgetRemaining,
      pnlUsd,
      pnlPct,
    });
  }

  // ── Price monitoring & safety exits ──

  startPriceMonitor(): void {
    log.info(MODULE, `Price monitor started — updating every ${CONFIG.PRICE_UPDATE_INTERVAL_MS / 1000}s`);
    this.priceInterval = setInterval(() => this.updatePrices(), CONFIG.PRICE_UPDATE_INTERVAL_MS);
  }

  stopPriceMonitor(): void {
    if (this.priceInterval) {
      clearInterval(this.priceInterval);
      this.priceInterval = null;
    }
  }

  private async updatePrices(): Promise<void> {
    const positions = Array.from(this.state.positions.values());
    if (positions.length === 0) return;

    const mints = positions.map(p => p.tokenMint);
    const prices = await getJupiterPrices(mints);

    for (const position of positions) {
      const newPrice = prices.get(position.tokenMint);
      if (newPrice && newPrice > 0) {
        position.currentPriceUsd = newPrice;
        if (position.entryPriceUsd > 0) {
          position.pnlPct = ((newPrice - position.entryPriceUsd) / position.entryPriceUsd) * 100;
          position.pnlUsd = position.sizeUsd * (position.pnlPct / 100);
        }
      }

      await this.checkSafetyExits(position);
    }
  }

  private async checkSafetyExits(position: CopyPosition): Promise<void> {
    if (position.status === 'closed') return;

    const holdTimeMin = (Date.now() - position.entryTime) / 60_000;

    if (position.pnlPct <= -CONFIG.EMERGENCY_STOP_LOSS_PCT) {
      await this.closePosition(position, `Emergency stop loss: ${position.pnlPct.toFixed(1)}%`);
      return;
    }

    if (holdTimeMin >= CONFIG.MAX_HOLD_TIME_MINUTES) {
      await this.closePosition(position, `Max hold time (${CONFIG.MAX_HOLD_TIME_MINUTES}m)`);
      return;
    }
  }

  // ── Status ──

  get budgetRemaining(): number {
    return this.state.budgetRemaining;
  }

  get closedPositions(): CopyPosition[] {
    return this.state.closedPositions;
  }

  printStatus(): void {
    const open = Array.from(this.state.positions.values());
    const runtime = formatHoldTime(Date.now() - this.state.startTime);
    const closed = this.state.wins + this.state.losses;
    const winRate = closed > 0 ? (this.state.wins / closed) * 100 : 0;

    log.banner('COPYBOT STATUS');
    console.log(`  Mode:            ${CONFIG.PAPER_TRADE ? 'Paper Trade' : 'LIVE'}`);
    console.log(`  Runtime:         ${runtime}`);
    console.log(`  Budget:          $${this.state.budgetRemaining.toFixed(2)} / $${CONFIG.STARTING_BUDGET_USD}`);
    console.log(`  Total PNL:       $${this.state.totalPnl.toFixed(2)}`);
    console.log(`  Trades:          ${this.state.tradesExecuted} total | ${closed} closed (W: ${this.state.wins} / L: ${this.state.losses} | ${winRate.toFixed(0)}%)`);
    console.log(`  Open positions:  ${open.length} / ${CONFIG.MAX_CONCURRENT_TRADES}`);

    if (open.length > 0) {
      console.log(`\n  Open Positions:`);
      for (const p of open) {
        const sign = p.pnlPct >= 0 ? '+' : '';
        const hold = formatHoldTime(Date.now() - p.entryTime);
        console.log(
          `    ${p.tokenSymbol.padEnd(10)} | Copied: ${p.copiedWalletLabel} | ` +
          `Entry: $${fmtPrice(p.entryPriceUsd)} | Now: $${fmtPrice(p.currentPriceUsd)} | ` +
          `PNL: ${sign}${p.pnlPct.toFixed(1)}% | Hold: ${hold}`
        );
      }
    }

    if (this.state.closedPositions.length > 0) {
      const recent = this.state.closedPositions.slice(-5).reverse();
      console.log(`\n  Recent Closed:`);
      for (const p of recent) {
        const sign = p.pnlPct >= 0 ? '+' : '';
        console.log(
          `    ${p.tokenSymbol.padEnd(10)} | ${sign}$${p.pnlUsd.toFixed(2)} (${sign}${p.pnlPct.toFixed(1)}%) | ${p.exitReason}`
        );
      }
    }
    console.log('');
  }
}

function fmtPrice(price: number): string {
  if (price === 0) return 'N/A';
  if (price < 0.00001) return price.toExponential(4);
  if (price < 0.01) return price.toFixed(8);
  if (price < 1) return price.toFixed(6);
  return price.toFixed(4);
}

function formatHoldTime(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}
