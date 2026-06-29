import { CONFIG } from './config.js';
import { HeliusTransaction, DetectedSwap, TokenInfo } from './types.js';
import { log } from './logger.js';

const MODULE = 'HELIUS';

// ── Fetch helper ──

async function fetchJSON<T>(url: string, options?: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      log.error(MODULE, `HTTP ${res.status}: ${url.split('?')[0]}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    log.error(MODULE, `Fetch error: ${err}`);
    return null;
  }
}

// ── Get recent transaction signatures for a wallet ──

interface SignatureInfo {
  signature: string;
  slot: number;
  blockTime: number | null;
  err: unknown | null;
  memo: string | null;
}

export async function getRecentSignatures(
  walletAddress: string,
  limit: number = CONFIG.MAX_SIGS_PER_POLL
): Promise<SignatureInfo[]> {
  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'getSignaturesForAddress',
    params: [
      walletAddress,
      { limit, commitment: 'confirmed' },
    ],
  };

  const data = await fetchJSON<{ result: SignatureInfo[] }>(
    CONFIG.SOLANA_RPC_URL,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );

  if (!data?.result) return [];
  return data.result.filter(s => s.err === null);
}

// ── Parse transactions via Helius Enhanced API ──

export async function parseTransactions(signatures: string[]): Promise<HeliusTransaction[]> {
  if (signatures.length === 0) return [];

  const url = `${CONFIG.HELIUS_API_BASE}/v0/transactions?api-key=${CONFIG.HELIUS_API_KEY}`;

  const data = await fetchJSON<HeliusTransaction[]>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transactions: signatures }),
  });

  return data ?? [];
}

// ── Extract swap details from a parsed transaction ──

export function extractSwap(
  tx: HeliusTransaction,
  walletAddress: string,
  walletLabel: string
): DetectedSwap | null {
  if (tx.type !== 'SWAP') return null;

  const swapEvent = tx.events?.swap;

  // Method 1: Use Helius swap event (preferred)
  if (swapEvent) {
    return extractFromSwapEvent(tx, swapEvent, walletAddress, walletLabel);
  }

  // Method 2: Fallback to token/native transfers
  return extractFromTransfers(tx, walletAddress, walletLabel);
}

function isSolMint(mint: string): boolean {
  return mint === CONFIG.SOL_MINT || mint === CONFIG.WSOL_MINT;
}

function extractFromSwapEvent(
  tx: HeliusTransaction,
  swap: NonNullable<NonNullable<HeliusTransaction['events']>['swap']>,
  walletAddress: string,
  walletLabel: string
): DetectedSwap | null {
  // BUY: wallet spends SOL, receives tokens
  if (swap.nativeInput && swap.tokenOutputs.length > 0) {
    const tokenOutput = swap.tokenOutputs.find(t => !isSolMint(t.mint));
    if (!tokenOutput) return null;

    const solAmount = parseInt(swap.nativeInput.amount) / CONFIG.LAMPORTS_PER_SOL;
    const decimals = tokenOutput.rawTokenAmount.decimals;
    const tokenAmount = parseInt(tokenOutput.rawTokenAmount.tokenAmount) / Math.pow(10, decimals);

    return {
      walletAddress, walletLabel, direction: 'BUY',
      tokenMint: tokenOutput.mint, tokenSymbol: '', tokenName: '',
      solAmount, tokenAmount, priceUsd: 0,
      signature: tx.signature, timestamp: tx.timestamp,
    };
  }

  // SELL: wallet spends tokens, receives SOL
  if (swap.nativeOutput && swap.tokenInputs.length > 0) {
    const tokenInput = swap.tokenInputs.find(t => !isSolMint(t.mint));
    if (!tokenInput) return null;

    const solAmount = parseInt(swap.nativeOutput.amount) / CONFIG.LAMPORTS_PER_SOL;
    const decimals = tokenInput.rawTokenAmount.decimals;
    const tokenAmount = parseInt(tokenInput.rawTokenAmount.tokenAmount) / Math.pow(10, decimals);

    return {
      walletAddress, walletLabel, direction: 'SELL',
      tokenMint: tokenInput.mint, tokenSymbol: '', tokenName: '',
      solAmount, tokenAmount, priceUsd: 0,
      signature: tx.signature, timestamp: tx.timestamp,
    };
  }

  // Token-to-token swap involving WSOL
  if (swap.tokenInputs.length > 0 && swap.tokenOutputs.length > 0) {
    const solInput = swap.tokenInputs.find(t => isSolMint(t.mint));
    const solOutput = swap.tokenOutputs.find(t => isSolMint(t.mint));
    const tokenInput = swap.tokenInputs.find(t => !isSolMint(t.mint));
    const tokenOutput = swap.tokenOutputs.find(t => !isSolMint(t.mint));

    if (solInput && tokenOutput) {
      const solAmount = parseInt(solInput.rawTokenAmount.tokenAmount) / Math.pow(10, solInput.rawTokenAmount.decimals);
      const tokenAmount = parseInt(tokenOutput.rawTokenAmount.tokenAmount) / Math.pow(10, tokenOutput.rawTokenAmount.decimals);
      return {
        walletAddress, walletLabel, direction: 'BUY',
        tokenMint: tokenOutput.mint, tokenSymbol: '', tokenName: '',
        solAmount, tokenAmount, priceUsd: 0,
        signature: tx.signature, timestamp: tx.timestamp,
      };
    }

    if (tokenInput && solOutput) {
      const tokenAmount = parseInt(tokenInput.rawTokenAmount.tokenAmount) / Math.pow(10, tokenInput.rawTokenAmount.decimals);
      const solAmount = parseInt(solOutput.rawTokenAmount.tokenAmount) / Math.pow(10, solOutput.rawTokenAmount.decimals);
      return {
        walletAddress, walletLabel, direction: 'SELL',
        tokenMint: tokenInput.mint, tokenSymbol: '', tokenName: '',
        solAmount, tokenAmount, priceUsd: 0,
        signature: tx.signature, timestamp: tx.timestamp,
      };
    }
  }

  return null;
}

function extractFromTransfers(
  tx: HeliusTransaction,
  walletAddress: string,
  walletLabel: string
): DetectedSwap | null {
  const tokensReceived = tx.tokenTransfers.filter(
    t => t.toUserAccount === walletAddress && !isSolMint(t.mint)
  );
  const tokensSent = tx.tokenTransfers.filter(
    t => t.fromUserAccount === walletAddress && !isSolMint(t.mint)
  );

  const solSent = tx.nativeTransfers
    .filter(t => t.fromUserAccount === walletAddress)
    .reduce((sum, t) => sum + t.amount, 0);
  const solReceived = tx.nativeTransfers
    .filter(t => t.toUserAccount === walletAddress)
    .reduce((sum, t) => sum + t.amount, 0);

  if (tokensReceived.length > 0 && solSent > solReceived) {
    const token = tokensReceived[0];
    return {
      walletAddress, walletLabel, direction: 'BUY',
      tokenMint: token.mint, tokenSymbol: '', tokenName: '',
      solAmount: (solSent - solReceived) / CONFIG.LAMPORTS_PER_SOL,
      tokenAmount: token.tokenAmount, priceUsd: 0,
      signature: tx.signature, timestamp: tx.timestamp,
    };
  }

  if (tokensSent.length > 0 && solReceived > solSent) {
    const token = tokensSent[0];
    return {
      walletAddress, walletLabel, direction: 'SELL',
      tokenMint: token.mint, tokenSymbol: '', tokenName: '',
      solAmount: (solReceived - solSent) / CONFIG.LAMPORTS_PER_SOL,
      tokenAmount: token.tokenAmount, priceUsd: 0,
      signature: tx.signature, timestamp: tx.timestamp,
    };
  }

  return null;
}

// ── Token info lookup (DexScreener) ──

const tokenInfoCache = new Map<string, TokenInfo>();
const TOKEN_CACHE_TTL_MS = 5 * 60_000;

export async function getTokenInfo(mint: string): Promise<TokenInfo> {
  const cached = tokenInfoCache.get(mint);
  if (cached && Date.now() - cached.lastUpdated < TOKEN_CACHE_TTL_MS) {
    return cached;
  }

  try {
    const data = await fetchJSON<{ pairs: Array<{
      baseToken: { symbol: string; name: string };
      priceUsd: string;
    }> | null }>(
      `${CONFIG.DEXSCREENER_BASE}/latest/dex/tokens/${mint}`
    );

    if (data?.pairs && data.pairs.length > 0) {
      const pair = data.pairs[0];
      const info: TokenInfo = {
        mint,
        symbol: pair.baseToken.symbol,
        name: pair.baseToken.name,
        priceUsd: parseFloat(pair.priceUsd) || 0,
        lastUpdated: Date.now(),
      };
      tokenInfoCache.set(mint, info);
      return info;
    }
  } catch { /* fall through */ }

  try {
    const data = await fetchJSON<{ data: Record<string, { price: string } | undefined> }>(
      `${CONFIG.JUPITER_PRICE_API}?ids=${mint}`
    );
    if (data?.data?.[mint]) {
      const info: TokenInfo = {
        mint,
        symbol: mint.slice(0, 6),
        name: mint.slice(0, 6),
        priceUsd: parseFloat(data.data[mint]!.price) || 0,
        lastUpdated: Date.now(),
      };
      tokenInfoCache.set(mint, info);
      return info;
    }
  } catch { /* fall through */ }

  return { mint, symbol: mint.slice(0, 6) + '...', name: mint.slice(0, 8), priceUsd: 0, lastUpdated: Date.now() };
}

// ── Jupiter price lookup (batch) ──

export async function getJupiterPrices(mints: string[]): Promise<Map<string, number>> {
  const prices = new Map<string, number>();
  if (mints.length === 0) return prices;

  const data = await fetchJSON<{ data: Record<string, { price: string } | undefined> }>(
    `${CONFIG.JUPITER_PRICE_API}?ids=${mints.join(',')}`
  );
  if (!data?.data) return prices;

  for (const [mint, info] of Object.entries(data.data)) {
    if (info?.price) prices.set(mint, parseFloat(info.price));
  }
  return prices;
}

// ── Get recent buyers of a token (used by seeder) ──

export async function getTokenRecentBuyers(tokenMint: string): Promise<string[]> {
  const sigs = await getRecentSignatures(tokenMint, CONFIG.SEEDER_LOOKBACK_SIGS);
  if (sigs.length === 0) return [];

  const signatures = sigs.map(s => s.signature);
  const buyers: string[] = [];

  for (let i = 0; i < signatures.length; i += CONFIG.TX_PARSE_BATCH_SIZE) {
    const batch = signatures.slice(i, i + CONFIG.TX_PARSE_BATCH_SIZE);
    const parsed = await parseTransactions(batch);
    for (const tx of parsed) {
      if (tx.type !== 'SWAP') continue;
      for (const transfer of tx.tokenTransfers) {
        if (transfer.mint === tokenMint && transfer.toUserAccount) {
          buyers.push(transfer.toUserAccount);
        }
      }
    }
  }

  return [...new Set(buyers)];
}
