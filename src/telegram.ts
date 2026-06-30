import { CONFIG } from './config.js';
import { log } from './logger.js';
import type { WalletPerformance } from './copy-trader.js';

const MODULE = 'TELEGRAM';

export class TelegramAlert {
  private botToken: string;
  private chatId: string;
  private enabled: boolean;

  constructor() {
    this.botToken = CONFIG.TELEGRAM_BOT_TOKEN;
    this.chatId = CONFIG.TELEGRAM_CHAT_ID;
    this.enabled = !!(this.botToken && this.chatId);

    if (!this.enabled) {
      log.warn(MODULE, 'Telegram not configured — alerts will only show in console');
    } else {
      log.success(MODULE, 'Telegram alerts enabled');
    }
  }

  // ── TRADE CLOSED (sent AFTER exit only) ──

  async sendTradeAlert(data: {
    copiedWallet: string;
    tokenName: string;
    capitalBeforeBuy: number;
    capitalAfterSell: number;
    pnlUsd: number;
    pnlPct: number;
  }): Promise<void> {
    const pnlEmoji = data.pnlUsd >= 0 ? '\u{1F7E2}' : '\u{1F534}';
    const sign = data.pnlUsd >= 0 ? '\\+' : '\\-';

    const msg = [
      `${pnlEmoji} *COPYBOT \\- TRADE CLOSED*`,
      ``,
      `*Copied Wallet:* ${this.esc(data.copiedWallet)}`,
      `*Token:* ${this.esc(data.tokenName)}`,
      `*Capital Before Buy:* \\$${this.esc(data.capitalBeforeBuy.toFixed(2))}`,
      `*Capital After Sell:* \\$${this.esc(data.capitalAfterSell.toFixed(2))}`,
      `*PNL:* ${sign}\\$${this.esc(Math.abs(data.pnlUsd).toFixed(2))}`,
      `*PNL %:* ${sign}${this.esc(data.pnlPct.toFixed(2))}%`,
    ].join('\n');

    await this.send(msg);
  }

  // ── BOT STOPPED ──

  async sendStoppedAlert(reason: string): Promise<void> {
    const msg = [
      `\u{1F6D1} *COPYBOT \\- BOT STOPPED*`,
      ``,
      `*Reason:* ${this.esc(reason)}`,
      `*Mode:* ${CONFIG.PAPER_TRADE ? '\u{1F4DD} Paper Trade' : '\u{1F4B0} LIVE'}`,
    ].join('\n');

    await this.send(msg);
  }

  // ── BOT STARTED ──

  async sendStartedAlert(walletCount: number): Promise<void> {
    const msg = [
      `\u{1F680} *COPYBOT \\- STARTED*`,
      ``,
      `*Mode:* ${CONFIG.PAPER_TRADE ? '\u{1F4DD} Paper Trade' : '\u{1F4B0} LIVE'}`,
      `*Budget:* \\$${CONFIG.STARTING_BUDGET_USD}`,
      `*Trade Size:* \\$${CONFIG.TRADE_SIZE_USD}`,
      `*Max Concurrent:* ${CONFIG.MAX_CONCURRENT_TRADES}`,
      `*Wallets Watched:* ${walletCount}`,
    ].join('\n');

    await this.send(msg);
  }

  // ── DAILY WALLET RANKING (sent at midnight MST) ──

  async sendDailyRanking(data: {
    wallets: WalletPerformance[];
    totalPnl: number;
    budgetRemaining: number;
    walletCount: number;
  }): Promise<void> {
    const lines: string[] = [
      `\u{1F4CA} *COPYBOT \\- DAILY WALLET REPORT*`,
      ``,
    ];

    if (data.wallets.length === 0) {
      lines.push(`_No trades recorded yet\\._`);
    } else {
      for (let i = 0; i < data.wallets.length; i++) {
        const w = data.wallets[i];
        const rank = i + 1;
        const medal = rank === 1 ? '\u{1F947}' : rank === 2 ? '\u{1F948}' : rank === 3 ? '\u{1F949}' : `${rank}\\.`;
        const totalPnl = w.pnlUsd + w.unrealizedPnl;
        const sign = totalPnl >= 0 ? '\\+' : '\\-';
        const winRate = w.trades > 0 ? ((w.wins / w.trades) * 100).toFixed(0) : '0';

        lines.push(`${medal} *${this.esc(w.label)}*`);
        lines.push(`   PNL: ${sign}\\$${this.esc(Math.abs(totalPnl).toFixed(2))} \\| Trades: ${w.trades} \\| W/L: ${w.wins}/${w.losses} \\(${this.esc(winRate)}%\\)`);
        if (w.openTrades > 0) {
          const uSign = w.unrealizedPnl >= 0 ? '\\+' : '\\-';
          lines.push(`   Open: ${w.openTrades} \\| Unrealized: ${uSign}\\$${this.esc(Math.abs(w.unrealizedPnl).toFixed(2))}`);
        }
        lines.push(``);
      }
    }

    const totalSign = data.totalPnl >= 0 ? '\\+' : '\\-';
    lines.push(`\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-`);
    lines.push(`*Total PNL:* ${totalSign}\\$${this.esc(Math.abs(data.totalPnl).toFixed(2))}`);
    lines.push(`*Budget:* \\$${this.esc(data.budgetRemaining.toFixed(2))} / \\$${CONFIG.STARTING_BUDGET_USD}`);
    lines.push(`*Wallets Tracked:* ${data.walletCount}`);

    await this.send(lines.join('\n'));
  }

  // ── Internal ──

  private async send(text: string): Promise<void> {
    if (!this.enabled) return;

    try {
      const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.chatId,
          text,
          parse_mode: 'MarkdownV2',
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        const err = await res.text();
        log.error(MODULE, `Failed to send: ${err}`);
      }
    } catch (err) {
      log.error(MODULE, `Send error: ${err}`);
    }
  }

  private esc(text: string): string {
    return text.replace(/[_*[\]()~`>#+=|{}.!\\-]/g, '\\$&');
  }
}
