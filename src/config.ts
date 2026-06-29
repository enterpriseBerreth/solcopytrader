import 'dotenv/config';

function extractHeliusKey(rpcUrl: string): string {
  try {
    const url = new URL(rpcUrl);
    return url.searchParams.get('api-key') || '';
  } catch {
    return '';
  }
}

const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://mainnet.helius-rpc.com/?api-key=';

export const CONFIG = {
  // ── Mode ──
  PAPER_TRADE: process.env.PAPER_TRADE !== 'false',

  // ── Budget ──
  STARTING_BUDGET_USD: 1000,
  TRADE_SIZE_USD: 30,
  MAX_CONCURRENT_TRADES: 3,

  // ── Watched Wallets (starting set) ──
  WATCHED_WALLETS: (process.env.WATCHED_WALLETS || [
    '4nvNc7dDEqKKLM4Sr9Kgk3t1of6f8G66kT64VoC95LYh',
    'kiLogfWUXp7nby7Xi6R9t7u8ERQyRdAzg6wBjvuE49uA',
    'UEQxhkAVz71w2WBa9BYSoZrydhYNJaKmfNomoNs9E4t',
  ].join(',')).split(',').map(w => w.trim()).filter(Boolean),

  // ── Wallet Seeder ──
  MAX_WATCHED_WALLETS: 10,
  SEEDER_INTERVAL_MS: 5 * 60_000,
  SEEDER_MIN_COBUYS: 2,
  SEEDER_LOOKBACK_SIGS: 20,

  // ── Monitoring ──
  WALLET_POLL_INTERVAL_MS: 5_000,
  PRICE_UPDATE_INTERVAL_MS: 5_000,
  MAX_SIGS_PER_POLL: 10,
  TX_PARSE_BATCH_SIZE: 5,

  // ── Safety Exits ──
  MAX_HOLD_TIME_MINUTES: 240,
  EMERGENCY_STOP_LOSS_PCT: 50,

  // ── API Endpoints ──
  SOLANA_RPC_URL,
  HELIUS_API_KEY: process.env.HELIUS_API_KEY || extractHeliusKey(SOLANA_RPC_URL),
  HELIUS_API_BASE: 'https://api.helius.dev',
  JUPITER_PRICE_API: 'https://api.jup.ag/price/v2',
  DEXSCREENER_BASE: 'https://api.dexscreener.com',

  // ── Telegram ──
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '',

  // ── Constants ──
  SOL_MINT: 'So11111111111111111111111111111111111111112',
  WSOL_MINT: 'So11111111111111111111111111111111111111112',
  LAMPORTS_PER_SOL: 1_000_000_000,
} as const;
