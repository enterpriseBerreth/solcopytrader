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
      remainingSizeUsd: sizeUsd,
      capitalBeforeBuy: capitalBefore,
      copiedWalletEntryTokens: swap.tokenAmount,
      copiedWalletRemainingTokens: swap.tokenAmount,
      totalRealizedPnlUsd: 0,
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

    await this.telegram.sendBuyAlert({
      copiedWallet: swap.walletLabel,
      tokenName: `${swap.tokenSymbol} (${swap.tokenName})`,
      priceUsd,
      sizeUsd,
      budgetRemaining: this.state.budgetRemaining,
      openSlots: `${this.openPositionCount}/${CONFIG.MAX_CONCURRENT_TRADES}`,
    });
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

    // Get exit price from the actual sell transaction
    let exitPrice = swap.priceUsd;
    if (exitPrice <= 0) {
      const prices = await getJupiterPrices([swap.tokenMint]);
      exitPrice = prices.get(swap.tokenMint) || position.currentPriceUsd;
    }
    position.currentPriceUsd = exitPrice;

    // Calculate what percentage of their original position they sold
    const sellTokens = Math.min(swap.tokenAmount, position.copiedWalletRemainingTokens);
    const sellPct = position.copiedWalletEntryTokens > 0
      ? sellTokens / position.copiedWalletEntryTokens
      : 1;

    // Calculate our sell portion (based on original entry size)
    const portionSizeUsd = position.sizeUsd * sellPct;

    // Calculate PNL % (wallet's actual price performance)
    const pnlPct = position.entryPriceUsd > 0
      ? ((exitPrice - position.entryPriceUsd) / position.entryPriceUsd) * 100
      : 0;
    const portionPnlUsd = portionSizeUsd * (pnlPct / 100);

    // Update position tracking
    position.copiedWalletRemainingTokens -= sellTokens;
    position.remainingSizeUsd -= portionSizeUsd;
    position.totalRealizedPnlUsd += portionPnlUsd;

    // Return proceeds to budget
    const proceeds = portionSizeUsd + portionPnlUsd;
    this.state.budgetRemaining += Math.max(0, proceeds);
    this.state.totalPnl += portionPnlUsd;

    const isFullClose = position.copiedWalletRemainingTokens <= 0 || position.remainingSizeUsd <= 0.01;
    const sellPctDisplay = Math.min(sellPct * 100, 100);

    const holdTime = formatHoldTime(Date.now() - position.entryTime);
    const sign = portionPnlUsd >= 0 ? '+' : '';

    log.trade(
      MODULE,
      `COPY SELL ${isFullClose ? '(FULL)' : `(${sellPctDisplay.toFixed(0)}%)`} ${position.tokenSymbol} | ` +
      `PNL: ${sign}$${portionPnlUsd.toFixed(2)} (${sign}${pnlPct.toFixed(2)}%) | ` +
      `Portion: $${portionSizeUsd.toFixed(2)} | Hold: ${holdTime}`
    );

    // Send Telegram alert for this sell
    await this.telegram.sendTradeAlert({
      copiedWallet: position.copiedWalletLabel,
      tokenName: `${position.tokenSymbol} (${position.tokenName})`,
      entryPriceUsd: position.entryPriceUsd,
      exitPriceUsd: exitPrice,
      capitalBeforeBuy: portionSizeUsd,
      capitalAfterSell: portionSizeUsd + portionPnlUsd,
      pnlUsd: portionPnlUsd,
      pnlPct,
      sellPct: sellPctDisplay,
      isPartial: !isFullClose,
    });

    if (isFullClose) {
      // Fully close the position
      position.exitPriceUsd = exitPrice;
      position.exitTime = Date.now();
      position.status = 'closed';
      position.pnlUsd = position.totalRealizedPnlUsd;
      position.pnlPct = position.entryPriceUsd > 0
        ? ((exitPrice - position.entryPriceUsd) / position.entryPriceUsd) * 100
        : 0;
      position.exitReason = `Copied exit from ${swap.walletLabel}`;

      if (position.totalRealizedPnlUsd >= 0) this.state.wins++;
      else this.state.losses++;

      this.state.positions.delete(position.tokenMint);
      this.tokenBuyerMap.delete(position.tokenMint);
      this.state.closedPositions.push(position);

      log.info(MODULE, `Position fully closed — total realized PNL: ${sign}$${position.totalRealizedPnlUsd.toFixed(2)}`);
    } else {
      log.info(MODULE, `Position partially closed — remaining: $${position.remainingSizeUsd.toFixed(2)} (${((position.copiedWalletRemainingTokens / position.copiedWalletEntryTokens) * 100).toFixed(0)}% of tokens)`);
    }
  }

  // ── Close position (used by safety exits — always closes 100%) ──

  private async closePosition(position: CopyPosition, reason: string): Promise<void> {
    const currentPrice = position.currentPriceUsd;
    const entryPrice = position.entryPriceUsd;

    let pnlPct = 0;
    if (entryPrice > 0) {
      pnlPct = ((currentPrice - entryPrice) / entryPrice) * 100;
    }
    // PNL on remaining position + any already realized from partial sells
    const remainingPnlUsd = position.remainingSizeUsd * (pnlPct / 100);
    const totalPnlUsd = position.totalRealizedPnlUsd + remainingPnlUsd;
    const proceeds = position.remainingSizeUsd + remainingPnlUsd;

    position.exitPriceUsd = currentPrice;
    position.exitTime = Date.now();
    position.status = 'closed';
    position.pnlUsd = totalPnlUsd;
    position.pnlPct = pnlPct;
    position.exitReason = reason;

    this.state.budgetRemaining += Math.max(0, proceeds);
    this.state.totalPnl += remainingPnlUsd;

    if (totalPnlUsd >= 0) this.state.wins++;
    else this.state.losses++;

    this.state.positions.delete(position.tokenMint);
    this.tokenBuyerMap.delete(position.tokenMint);
    this.state.closedPositions.push(position);

    const holdTime = formatHoldTime(position.exitTime - position.entryTime);
    const sign = totalPnlUsd >= 0 ? '+' : '';

    log.trade(
      MODULE,
      `COPY SELL (FULL) ${position.tokenSymbol} | PNL: ${sign}$${totalPnlUsd.toFixed(2)} (${sign}${pnlPct.toFixed(2)}%) | ` +
      `Reason: ${reason} | Hold: ${holdTime}`
    );

    await this.telegram.sendTradeAlert({
      copiedWallet: position.copiedWalletLabel,
      tokenName: `${position.tokenSymbol} (${position.tokenName})`,
      entryPriceUsd: position.entryPriceUsd,
      exitPriceUsd: currentPrice,
      capitalBeforeBuy: position.remainingSizeUsd,
      capitalAfterSell: position.remainingSizeUsd + remainingPnlUsd,
      pnlUsd: remainingPnlUsd,
      pnlPct,
      sellPct: 100,
      isPartial: false,
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

  get totalPnl(): number {
    return this.state.totalPnl;
  }

  get closedPositions(): CopyPosition[] {
    return this.state.closedPositions;
  }

  // ── Per-wallet performance stats (for daily report) ──

  getWalletPerformance(): WalletPerformance[] {
    const map = new Map<string, WalletPerformance>();

    // Aggregate closed positions by wallet
    for (const p of this.state.closedPositions) {
      let wp = map.get(p.copiedWallet);
      if (!wp) {
        wp = { wallet: p.copiedWallet, label: p.copiedWalletLabel, trades: 0, wins: 0, losses: 0, pnlUsd: 0, openTrades: 0, unrealizedPnl: 0 };
        map.set(p.copiedWallet, wp);
      }
      wp.trades++;
      wp.pnlUsd += p.pnlUsd;
      if (p.pnlUsd >= 0) wp.wins++;
      else wp.losses++;
    }

    // Include open positions (unrealized PNL)
    for (const p of this.state.positions.values()) {
      let wp = map.get(p.copiedWallet);
      if (!wp) {
        wp = { wallet: p.copiedWallet, label: p.copiedWalletLabel, trades: 0, wins: 0, losses: 0, pnlUsd: 0, openTrades: 0, unrealizedPnl: 0 };
        map.set(p.copiedWallet, wp);
      }
      wp.openTrades++;
      wp.unrealizedPnl += p.pnlUsd;
    }

    // Sort by total PNL (realized + unrealized) descending
    return Array.from(map.values()).sort((a, b) => (b.pnlUsd + b.unrealizedPnl) - (a.pnlUsd + a.unrealizedPnl));
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

export interface WalletPerformance {
  wallet: string;
  label: string;
  trades: number;
  wins: number;
  losses: number;
  pnlUsd: number;
  openTrades: number;
  unrealizedPnl: number;
}
