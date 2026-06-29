// ── Copytrade Types ──

export interface WatchedWallet {
  address: string;
  label: string;
  addedAt: number;
  source: 'manual' | 'seeded';
  stats: WalletStats;
}

export interface WalletStats {
  tradesDetected: number;
  tradesCopied: number;
  totalPnlUsd: number;
  winCount: number;
  lossCount: number;
}

// ── Helius Enhanced Transaction ──

export interface HeliusTransaction {
  description: string;
  type: string;
  source: string;
  fee: number;
  feePayer: string;
  signature: string;
  slot: number;
  timestamp: number;
  nativeTransfers: NativeTransfer[];
  tokenTransfers: TokenTransfer[];
  events?: {
    swap?: SwapEvent;
  };
}

export interface NativeTransfer {
  fromUserAccount: string;
  toUserAccount: string;
  amount: number;
}

export interface TokenTransfer {
  fromTokenAccount: string;
  toTokenAccount: string;
  fromUserAccount: string;
  toUserAccount: string;
  tokenAmount: number;
  mint: string;
  tokenStandard: string;
}

export interface SwapEvent {
  nativeInput: { account: string; amount: string } | null;
  nativeOutput: { account: string; amount: string } | null;
  tokenInputs: SwapTokenInfo[];
  tokenOutputs: SwapTokenInfo[];
  tokenFees: unknown[];
  nativeFees: unknown[];
  innerSwaps: unknown[];
}

export interface SwapTokenInfo {
  userAccount: string;
  tokenAccount: string;
  mint: string;
  rawTokenAmount: {
    tokenAmount: string;
    decimals: number;
  };
}

// ── Detected Wallet Action ──

export type SwapDirection = 'BUY' | 'SELL';

export interface DetectedSwap {
  walletAddress: string;
  walletLabel: string;
  direction: SwapDirection;
  tokenMint: string;
  tokenSymbol: string;
  tokenName: string;
  solAmount: number;
  tokenAmount: number;
  priceUsd: number;
  signature: string;
  timestamp: number;
}

// ── Paper Trade Position ──

export type PositionStatus = 'open' | 'closed';

export interface CopyPosition {
  id: string;
  copiedWallet: string;
  copiedWalletLabel: string;
  tokenMint: string;
  tokenSymbol: string;
  tokenName: string;

  entryPriceUsd: number;
  currentPriceUsd: number;
  exitPriceUsd: number;

  sizeUsd: number;
  capitalBeforeBuy: number;

  entryTime: number;
  exitTime: number;

  status: PositionStatus;
  pnlUsd: number;
  pnlPct: number;

  exitReason: string;
}

// ── Token Info Cache ──

export interface TokenInfo {
  mint: string;
  symbol: string;
  name: string;
  priceUsd: number;
  lastUpdated: number;
}

// ── Wallet Seeder Candidate ──

export interface SeederCandidate {
  address: string;
  coBuyCount: number;
  coBuyTokens: string[];
  firstSeen: number;
  lastSeen: number;
}

// ── Bot State ──

export interface BotState {
  budgetRemaining: number;
  totalPnl: number;
  tradesExecuted: number;
  positions: Map<string, CopyPosition>;
  closedPositions: CopyPosition[];
  startTime: number;
  wins: number;
  losses: number;
}
