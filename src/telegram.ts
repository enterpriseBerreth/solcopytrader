import { CONFIG } from './config.js';
import { log } from './logger.js';

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
    const sign = data.pnlUsd >= 0 ? '+' : '';

    const msg = [
      `${pnlEmoji} *COPYBOT \\- TRADE CLOSED*`,
      ``,
      `*Copied Wallet:* ${this.esc(data.copiedWallet)}`,
      `*Token:* ${this.esc(data.tokenName)}`,
      `*Capital Before Buy:* \\$${data.capitalBeforeBuy.toFixed(2)}`,
      `*Capital After Sell:* \\$${data.capitalAfterSell.toFixed(2)}`,
      `*PNL:* ${sign}\\$${Math.abs(data.pnlUsd).toFixed(2)}`,
      `*PNL %:* ${sign}${data.pnlPct.toFixed(2)}%`,
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
