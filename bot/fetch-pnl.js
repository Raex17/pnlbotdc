'use strict';

const { Connection, PublicKey } = require('@solana/web3.js');
const { BorshCoder, EventParser } = require('@coral-xyz/anchor');
const { IDL } = require('@meteora-ag/dlmm');
const crypto = require('crypto');

const DEFAULT_RPC = 'https://pump.helius-rpc.com';
const METEORA_API_BASE = 'https://dlmm.datapi.meteora.ag';
const DLMM_PROGRAM_ID = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';
const JUP_PRICE_APIS = ['https://api.jup.ag/price/v3', 'https://lite-api.jup.ag/price/v3'];
const DLMM_EVENT_PARSER = new EventParser(new PublicKey(DLMM_PROGRAM_ID), new BorshCoder(IDL));

const SYMBOL_MAP = new Map([
  ['So11111111111111111111111111111111111111112', 'SOL'],
  ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'USDC'],
  ['Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', 'USDT'],
  ['JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', 'JUP'],
  ['DezXAZ8z7PnrnRJjz3wXBoRgixCa6Qf4r7YaB1pPB263', 'BONK'],
]);

function toSymbol(mint) {
  return SYMBOL_MAP.get(String(mint || '')) || String(mint || '?').slice(0, 4).toUpperCase();
}

function safeNum(v) {
  const n = Number(v || 0);
  return Number.isFinite(n) ? n : 0;
}

function round6(n) {
  const v = Number(n || 0);
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * 1e6) / 1e6;
}

function uiAmount(raw, decimals) {
  const n = Number(raw || 0);
  if (!Number.isFinite(n)) return 0;
  return n / (10 ** Number(decimals || 0));
}

function computeDisc(snakeName) {
  return Array.from(crypto.createHash('sha256').update(`global:${snakeName}`).digest()).slice(0, 8);
}

const REMOVE_LIQ_DISCS = [
  computeDisc('remove_liquidity'),
  computeDisc('remove_liquidity_by_range'),
  computeDisc('remove_liquidity_one_side'),
  computeDisc('remove_all_liquidity'),
  computeDisc('remove_liquidity2'),
  computeDisc('remove_liquidity_by_range2'),
  computeDisc('remove_liquidity_one_side2'),
];

function isRemoveLiqIx(data) {
  if (!data || data.length < 8) return false;
  for (const disc of REMOVE_LIQ_DISCS) {
    let match = true;
    for (let i = 0; i < 8; i++) {
      if (data[i] !== disc[i]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}

function getTxAccountKeys(tx) {
  const msg = tx.transaction.message;
  const statics = msg.staticAccountKeys || msg.accountKeys || [];
  const loaded = tx.meta?.loadedAddresses;
  return [...statics, ...(loaded?.writable || []), ...(loaded?.readonly || [])].map((k) =>
    typeof k === 'string' ? k : (k.toBase58?.() || String(k))
  );
}

function getTxInstructions(tx) {
  const msg = tx.transaction.message;
  return msg.compiledInstructions || msg.instructions || [];
}

function getIxData(ix) {
  const raw = ix.data;
  if (!raw) return null;
  if (raw instanceof Uint8Array || Buffer.isBuffer(raw)) return Buffer.from(raw);
  if (typeof raw === 'string') {
    try {
      const bs58 = require('bs58');
      const mod = bs58.default || bs58;
      return Buffer.from(mod.decode(raw));
    } catch {
      return Buffer.from(raw, 'base64');
    }
  }
  return null;
}

function toBase58(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  return value.toBase58?.() || String(value);
}

function toNumberLike(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'bigint') return Number(value);
  if (value && typeof value.toString === 'function') {
    const n = Number(value.toString());
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function getEventAmountPair(data) {
  if (!data || typeof data !== 'object') return [0, 0];
  const amounts = Array.isArray(data.amounts) ? data.amounts : [];
  return [
    amounts.length >= 1 ? toNumberLike(amounts[0]) : 0,
    amounts.length >= 2 ? toNumberLike(amounts[1]) : 0,
  ];
}

function parseDlmmEvents(tx) {
  const logs = tx?.meta?.logMessages;
  if (!Array.isArray(logs) || !logs.length) return [];
  try {
    return Array.from(DLMM_EVENT_PARSER.parseLogs(logs));
  } catch {
    return [];
  }
}

async function getParsedTransactions(connection, signatures) {
  const out = [];
  const chunkSize = 20;
  for (let i = 0; i < signatures.length; i += chunkSize) {
    const batch = signatures.slice(i, i + chunkSize);
    const rows = await Promise.all(batch.map(async (signature) => {
      try {
        return await connection.getTransaction(signature, {
          maxSupportedTransactionVersion: 0,
          commitment: 'confirmed',
        });
      } catch {
        return null;
      }
    }));
    out.push(...rows.filter(Boolean));
  }
  return out;
}

function buildFlowEntry({ timestamp, tokenXRaw, tokenYRaw, tokenXDecimals, tokenYDecimals, priceXUsd, priceYUsd }) {
  const tokenXUi = round6(uiAmount(tokenXRaw, tokenXDecimals));
  const tokenYUi = round6(uiAmount(tokenYRaw, tokenYDecimals));
  const amountUsd = round6((tokenXUi * safeNum(priceXUsd)) + (tokenYUi * safeNum(priceYUsd)));
  return { timestamp, amountUsd, tokenXUi, tokenYUi };
}

async function fetchPoolMeta(poolAddress) {
  const address = String(poolAddress || '').trim();
  if (!address) return {};
  const res = await fetch(`${METEORA_API_BASE}/pools/${address}`);
  if (res.ok) {
    const r = await res.json();
    if (r && typeof r === 'object' && !Array.isArray(r)) {
      const txObj = r.token_x && typeof r.token_x === 'object' ? r.token_x : null;
      const tyObj = r.token_y && typeof r.token_y === 'object' ? r.token_y : null;
      const mintX = String(txObj?.address || r.token_x_mint || r.tokenXMint || r.mint_x || '');
      const mintY = String(tyObj?.address || r.token_y_mint || r.tokenYMint || r.mint_y || '');
      const decX = Number(txObj?.decimals ?? r.token_x_decimals ?? 0);
      const decY = Number(tyObj?.decimals ?? r.token_y_decimals ?? 0);
      const binStep = Number(r.pool_config?.bin_step ?? r.bin_step ?? 0);
      const baseFeePct = safeNum(r.pool_config?.base_fee_pct ?? r.base_fee_pct ?? 0);
      const name = String(r.name || '');
      if (name || binStep || mintX) {
        return {
          name,
          token_x_mint: mintX,
          token_y_mint: mintY,
          token_x_decimals: decX,
          token_y_decimals: decY,
          bin_step: binStep,
          base_fee_pct: baseFeePct,
        };
      }
    }
  }
  const body = await res.text().catch(() => '');
  throw new Error(`Meteora pool API ${res.status}: ${body || res.statusText}`);
}

async function fetchJupiterPriceMap(mints) {
  const ids = [...new Set(mints.map((x) => String(x || '').trim()).filter(Boolean))];
  if (!ids.length) return {};
  for (const baseUrl of JUP_PRICE_APIS) {
    try {
      const res = await fetch(`${baseUrl}?ids=${encodeURIComponent(ids.join(','))}`);
      if (!res.ok) continue;
      const json = await res.json();
      const raw = json?.data && typeof json.data === 'object' ? json.data : (json || {});
      const out = {};
      for (const mint of ids) {
        const row = raw[mint];
        const price = safeNum(row?.price || row?.usdPrice || 0);
        if (price > 0) out[mint] = { price };
      }
      if (Object.keys(out).length) return out;
    } catch {}
  }
  return {};
}

function parseHistoricalUsd(entry) {
  const explicit = safeNum(entry?.totalUsd ?? entry?.total_usd ?? 0);
  if (explicit > 0) return explicit;
  return safeNum(entry?.amountXUsd ?? entry?.amount_x_usd ?? 0) + safeNum(entry?.amountYUsd ?? entry?.amount_y_usd ?? 0);
}

function parseHistoricalFlowEntry(entry) {
  const rawTs = Number(entry?.blockTime ?? entry?.block_time ?? 0);
  const timestamp = rawTs > 1e12 ? Math.floor(rawTs / 1000) : rawTs;
  return {
    timestamp,
    amountUsd: round6(parseHistoricalUsd(entry)),
    tokenXUi: round6(safeNum(entry?.amountX ?? entry?.amount_x ?? 0)),
    tokenYUi: round6(safeNum(entry?.amountY ?? entry?.amount_y ?? 0)),
  };
}

async function fetchPositionHistorical(positionAddress) {
  const address = String(positionAddress || '').trim();
  if (!address) return [];
  const res = await fetch(`${METEORA_API_BASE}/positions/${address}/historical?order_direction=asc`);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Meteora position history API ${res.status}: ${body || res.statusText}`);
  }
  const json = await res.json();
  return Array.isArray(json?.events) ? json.events : [];
}

async function fetchPositionFlowData(connection, positionAddress, tokenXDecimals, tokenYDecimals, priceXUsd, priceYUsd) {
  const out = { deposits: [], withdrawals: [], claimedFees: [], openedAt: 0 };
  const p = String(positionAddress || '').trim();
  if (!p) return out;

  try {
    const events = await fetchPositionHistorical(p);
    if (events.length) {
      for (const entry of events) {
        const type = String(entry?.eventType ?? entry?.event_type ?? '').toLowerCase();
        const flowEntry = parseHistoricalFlowEntry(entry);
        const hasValue = flowEntry.amountUsd > 0 || flowEntry.tokenXUi > 0 || flowEntry.tokenYUi > 0;
        if (type === 'add') out.deposits.push(flowEntry);
        else if (type === 'remove') out.withdrawals.push(flowEntry);
        else if (type === 'claim_fee' && hasValue) out.claimedFees.push(flowEntry);
      }
      const firstEvent = events[0];
      const rawTs = Number(firstEvent?.blockTime ?? firstEvent?.block_time ?? 0);
      out.openedAt = rawTs > 1e12 ? Math.floor(rawTs / 1000) : rawTs;
      return out;
    }
  } catch {}

  const sigInfos = await connection.getSignaturesForAddress(new PublicKey(p), { limit: 1000, commitment: 'confirmed' }).catch(() => []);
  if (!sigInfos.length) return out;

  out.openedAt = sigInfos[sigInfos.length - 1]?.blockTime || 0;

  const signatures = sigInfos.map((row) => row.signature).filter(Boolean);
  const txs = await getParsedTransactions(connection, signatures);

  for (const parsedTx of txs) {
    const timestamp = Number(parsedTx?.blockTime || 0);
    const events = parseDlmmEvents(parsedTx);
    for (const evt of events) {
      const name = String(evt?.name || '');
      const data = evt?.data;
      if (toBase58(data?.position) !== p) continue;

      if (name === 'AddLiquidity') {
        const [tokenXRaw, tokenYRaw] = getEventAmountPair(data);
        out.deposits.push(buildFlowEntry({ timestamp, tokenXRaw, tokenYRaw, tokenXDecimals, tokenYDecimals, priceXUsd, priceYUsd }));
      } else if (name === 'RemoveLiquidity') {
        const [tokenXRaw, tokenYRaw] = getEventAmountPair(data);
        out.withdrawals.push(buildFlowEntry({ timestamp, tokenXRaw, tokenYRaw, tokenXDecimals, tokenYDecimals, priceXUsd, priceYUsd }));
      } else if (name === 'ClaimFee' || name === 'ClaimFee2') {
        const tokenXRaw = toNumberLike(data?.feeX ?? data?.fee_x);
        const tokenYRaw = toNumberLike(data?.feeY ?? data?.fee_y);
        out.claimedFees.push(buildFlowEntry({ timestamp, tokenXRaw, tokenYRaw, tokenXDecimals, tokenYDecimals, priceXUsd, priceYUsd }));
      } else if (name === 'PositionCreate' && !out.openedAt) {
        out.openedAt = timestamp;
      }
    }
  }

  out.deposits.sort((a, b) => a.timestamp - b.timestamp);
  out.withdrawals.sort((a, b) => a.timestamp - b.timestamp);
  out.claimedFees.sort((a, b) => a.timestamp - b.timestamp);
  return out;
}

/**
 * Fetch PnL data for a remove-liquidity transaction.
 * @param {string} txSig
 * @param {string} [rpcUrl]
 * @returns {Promise<object>}
 */
async function fetchPnl(txSig, rpcUrl) {
  const connection = new Connection(rpcUrl || DEFAULT_RPC, 'confirmed');

  const tx = await connection.getTransaction(txSig, {
    maxSupportedTransactionVersion: 0,
    commitment: 'confirmed',
  });
  if (!tx) throw new Error('Transaction not found');

  const accountKeys = getTxAccountKeys(tx);
  const instructions = getTxInstructions(tx);
  const programIdx = accountKeys.findIndex((k) => k === DLMM_PROGRAM_ID);
  if (programIdx === -1) throw new Error('No DLMM instruction found in this transaction');

  const dlmmEvents = parseDlmmEvents(tx);
  const removeEvent = dlmmEvents.find((evt) => String(evt?.name || '') === 'RemoveLiquidity');

  let targetIx = null;
  let anyDlmmIx = null;
  for (const ix of instructions) {
    const pidx = ix.programIdIndex ?? ix.programIndex;
    if (pidx !== programIdx) continue;
    const data = getIxData(ix);
    anyDlmmIx = ix;
    if (data && isRemoveLiqIx(data)) {
      targetIx = ix;
      break;
    }
  }
  if (!targetIx) targetIx = anyDlmmIx;
  if (!targetIx) throw new Error('No DLMM instruction found');

  const ixAccounts = targetIx.accountKeyIndexes || targetIx.accounts || [];
  const positionAddress = toBase58(removeEvent?.data?.position) || accountKeys[ixAccounts[0]] || '';
  const lbPairAddress = toBase58(removeEvent?.data?.lbPair ?? removeEvent?.data?.lb_pair) || accountKeys[ixAccounts[1]] || '';
  if (!positionAddress || !lbPairAddress) throw new Error('Could not extract position/pool addresses');

  const closedAt = tx.blockTime || 0;
  const poolMeta = await fetchPoolMeta(lbPairAddress);

  const tokenXMint = String(poolMeta.token_x_mint || '');
  const tokenYMint = String(poolMeta.token_y_mint || '');
  const tokenXDecimals = Number(poolMeta.token_x_decimals ?? 0);
  const tokenYDecimals = Number(poolMeta.token_y_decimals ?? 0);
  const binStep = Number(poolMeta.bin_step ?? 0);
  const baseFeePct = safeNum(poolMeta.base_fee_pct ?? 0);

  let priceXUsd = 0;
  let priceYUsd = 0;
  if (tokenXMint || tokenYMint) {
    const prices = await fetchJupiterPriceMap([tokenXMint, tokenYMint].filter(Boolean));
    priceXUsd = safeNum(prices[tokenXMint]?.price || 0);
    priceYUsd = safeNum(prices[tokenYMint]?.price || 0);
  }

  const flowData = await fetchPositionFlowData(
    connection,
    positionAddress,
    tokenXDecimals,
    tokenYDecimals,
    priceXUsd,
    priceYUsd
  );

  const deposits = flowData.deposits;
  const withdrawals = flowData.withdrawals;
  const claimedFees = flowData.claimedFees;
  const openedAt = flowData.openedAt || 0;

  const depositedUsd = round6(deposits.reduce((s, d) => s + d.amountUsd, 0));
  const withdrawnUsd = round6(withdrawals.reduce((s, w) => s + w.amountUsd, 0));
  const claimedFeesUsd = round6(claimedFees.reduce((s, f) => s + f.amountUsd, 0));
  const pnlUsd = round6(withdrawnUsd + claimedFeesUsd - depositedUsd);
  const pnlPct = depositedUsd > 0 ? round6((pnlUsd / depositedUsd) * 100) : null;

  const tokenXSymbol = toSymbol(tokenXMint);
  const tokenYSymbol = toSymbol(tokenYMint);
  const pairName = String(poolMeta.name || `${tokenXSymbol}-${tokenYSymbol}`);

  return {
    positionAddress,
    lbPairAddress,
    pairName,
    tokenXSymbol,
    tokenYSymbol,
    tokenXMint,
    tokenYMint,
    binStep,
    baseFeePct,
    openedAt,
    closedAt,
    depositedUsd,
    withdrawnUsd,
    pnlUsd,
    pnlPct,
    priceXUsd,
    priceYUsd,
    hasFlowHistory: deposits.length > 0 || withdrawals.length > 0 || claimedFees.length > 0,
    deposits,
    withdrawals,
    claimedFees,
    claimedFeesUsd,
  };
}

module.exports = { fetchPnl };
