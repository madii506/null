'use strict';
/* NULL: most coins return null. One serverless function behind /api/*. It reads Solana, builds unsigned
 * transactions with pump.fun's official SDKs and simulates them; the user's own wallet signs. It never holds keys. */
const {
  Connection, PublicKey, TransactionMessage, VersionedTransaction, ComputeBudgetProgram, SystemProgram,
  AddressLookupTableAccount,
} = require('@solana/web3.js');
const {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT, MintLayout, AccountLayout,
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction,
  createCloseAccountInstruction,
} = require('@solana/spl-token');
const BN = require('bn.js');
const {
  PUMP_AMM_SDK, PUMP_AMM_PROGRAM_ID, GLOBAL_CONFIG_PDA, PUMP_AMM_FEE_CONFIG_PDA, POOL_ACCOUNT_NEW_SIZE,
  canonicalPumpPoolPda, computeFeesBps, buyBaseInput, sellBaseInput,
} = require('@pump-fun/pump-swap-sdk');

/* ---------------- settings ---------------- */
const E = (k, d = '') => String(process.env[k] == null ? d : process.env[k]).trim();
const CONFIG = {
  studio: E('NULL_STUDIO', ''),       // public key that controls the treasuries (createWithSeed base). No key is ever stored here.
  ca: E('NULL_CA', ''),               // $NULL mint, once launched
  x: E('NULL_X', ''),
  jug: E('NULL_HOST_FEE_WALLET', ''), // optional fee wallet for one-click hosting (off unless set)
  feeBps: Number(E('NULL_HOST_FEE_BPS', '0')),
  creatorBps: 6000, poolBps: 3000, voidBps: 1000, // locked at launch: creator / the coin's own pool / the void
};
try { if (CONFIG.jug) new PublicKey(CONFIG.jug); } catch (e) { CONFIG.jug = ''; }
try { if (CONFIG.studio) new PublicKey(CONFIG.studio); } catch (e) { CONFIG.studio = ''; }
try { if (CONFIG.ca) new PublicKey(CONFIG.ca); } catch (e) { CONFIG.ca = ''; }
const RPCS = [E('RPC_URL'), 'https://solana-rpc.publicnode.com', 'https://api.mainnet-beta.solana.com'].filter(Boolean);
// Address lookup tables that hold PumpSwap's global accounts. They shrink an add from SOL into ONE
// transaction. Each is re-read and only used while active; without them we fall back to two.
const ALT_KEYS = [E('MILK_ALT'), '9rVP9Ly5RC1nix3WDm5QgkoWJbxV7Kteth1KHtYk5hT9', '7Pau8dAeZTzVhVjQgTJeELY3XMPVSHidpzB78RnDE3bR'].filter(Boolean);
const U64_MAX = BigInt('18446744073709551615');
const MIN_TVL_SOL = 8;

const ERRORS = {
  6003: 'The pool has too little liquidity for this size.',
  6004: 'The price moved more than your slippage. Try again or raise slippage.',
  6016: 'That would buy more than the pool holds.',
  6018: 'Deposits are paused on PumpSwap right now.',
  6019: 'Withdrawals are paused on PumpSwap right now.',
  6020: 'Buys are paused on PumpSwap right now.',
  6021: 'Sells are paused on PumpSwap right now.',
  6039: 'Not enough SOL to cover the trade fees.',
  6040: 'The price moved more than your slippage. Try again or raise slippage.',
  6063: 'This pool does not have enough real SOL for that.',
  6064: 'This pool does not accept new liquidity.',
};

/* ---------------- http + rpc helpers ---------------- */
function send(res, code, body, cache) {
  res.setHeader('Cache-Control', cache || 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.status(code).send(JSON.stringify(body));
}
function http(code, msg) { const e = new Error(msg); e.code = code; return e; }
async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (e) { return {}; } }
  return await new Promise(r => { let d = ''; req.on('data', c => { d += c; if (d.length > 2e5) d = ''; }); req.on('end', () => { try { r(JSON.parse(d || '{}')); } catch (e) { r({}); } }); });
}
function timedFetch(ms) {
  return (url, opt = {}) => { const c = new AbortController(); const t = setTimeout(() => c.abort(), ms); return fetch(url, { ...opt, signal: c.signal }).finally(() => clearTimeout(t)); };
}
const conns = RPCS.map(u => new Connection(u, { commitment: 'confirmed', disableRetryOnRateLimit: true, fetch: timedFetch(9000) }));
async function rpc(fn) {
  let last;
  for (const c of conns) { try { return await fn(c); } catch (e) { last = e; } }
  throw http(502, 'Solana RPC is busy: ' + String(last && last.message || last).slice(0, 140));
}
async function getJson(url, ms = 7000) {
  const r = await timedFetch(ms)(url, { headers: { accept: 'application/json', 'user-agent': 'null/1.0' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return await r.json();
}
const mem = {};
// in-memory cache with request de-duplication; serves the last good value if a refresh fails
async function cached(key, ms, fn) {
  const c = mem[key];
  if (c && c.has && Date.now() - c.t < ms) return c.v;
  if (c && c.p) return c.p;
  const p = (async () => {
    try { const v = await fn(); mem[key] = { t: Date.now(), v, has: true }; return v; }
    catch (e) { if (c && c.has) { mem[key] = { t: c.t, v: c.v, has: true }; return c.v; } delete mem[key]; throw e; }
  })();
  mem[key] = Object.assign({}, c || {}, { p });
  return p;
}
function pk(s, what = 'address') {
  try { const k = new PublicKey(String(s || '').trim()); return k; } catch (e) { throw http(400, 'Invalid ' + what); }
}
const big = v => BigInt(v.toString());
const ceilDiv = (a, b) => (a + b - 1n) / b;
const sol = l => Number(l) / 1e9;
async function chunked(keys, size, fn) { const out = []; for (let i = 0; i < keys.length; i += size) out.push(...(await fn(keys.slice(i, i + size)))); return out; }
const multi = keys => chunked(keys, 100, part => rpc(c => c.getMultipleAccountsInfo(part)));

/* ---------------- protocol state ---------------- */
async function globals() {
  return cached('globals', 60000, async () => {
    const [g, f] = await rpc(c => c.getMultipleAccountsInfo([GLOBAL_CONFIG_PDA, PUMP_AMM_FEE_CONFIG_PDA]));
    if (!g) throw http(502, 'PumpSwap global config not found');
    return { globalConfig: PUMP_AMM_SDK.decodeGlobalConfig(g), feeConfig: f ? PUMP_AMM_SDK.decodeFeeConfig(f) : null };
  });
}
async function lookupTables() {
  return cached('alts', 300000, async () => {
    const keys = ALT_KEYS.map(k => new PublicKey(k));
    const infos = await rpc(c => c.getMultipleAccountsInfo(keys));
    const out = [];
    infos.forEach((info, i) => {
      if (!info) return;
      try {
        const state = AddressLookupTableAccount.deserialize(info.data);
        if (BigInt(state.deactivationSlot) !== U64_MAX) return;
        out.push(new AddressLookupTableAccount({ key: keys[i], state }));
      } catch (e) { }
    });
    return out;
  });
}
function feesFor(pool, globalConfig, feeConfig, supply, Rb, Rq) {
  const f = computeFeesBps({
    globalConfig, feeConfig, creator: pool.creator, baseMintSupply: new BN(supply.toString()), baseMint: pool.baseMint,
    baseReserve: new BN(Rb.toString()), quoteReserve: new BN((Rq + big(pool.virtualQuoteReserves)).toString()),
    quoteMint: pool.quoteMint, isMayhemMode: pool.isMayhemMode, creatorFeeBps: pool.creatorFeeBps,
  });
  const hasCreator = !pool.coinCreator.equals(PublicKey.default);
  return { lp: big(f.lpFeeBps), pr: big(f.protocolFeeBps), cr: hasCreator ? big(f.creatorFeeBps) : 0n };
}

// Everything the builders need for one pool (and optionally one wallet), in two RPC round trips.
async function loadState(poolKey, user) {
  const { globalConfig, feeConfig } = await globals();
  const poolInfo = await rpc(c => c.getAccountInfo(poolKey));
  if (!poolInfo || !poolInfo.owner.equals(PUMP_AMM_PROGRAM_ID)) throw http(404, 'That is not a PumpSwap pool.');
  const pool = PUMP_AMM_SDK.decodePool(poolInfo);
  const keys = [pool.baseMint, pool.quoteMint, pool.poolBaseTokenAccount, pool.poolQuoteTokenAccount];
  const uKeys = user ? [
    user,
    getAssociatedTokenAddressSync(pool.baseMint, user, true, TOKEN_PROGRAM_ID),
    getAssociatedTokenAddressSync(pool.baseMint, user, true, TOKEN_2022_PROGRAM_ID),
    getAssociatedTokenAddressSync(pool.quoteMint, user, true, TOKEN_PROGRAM_ID),
    getAssociatedTokenAddressSync(pool.quoteMint, user, true, TOKEN_2022_PROGRAM_ID),
    getAssociatedTokenAddressSync(pool.lpMint, user, true, TOKEN_2022_PROGRAM_ID),
  ] : [];
  const infos = await rpc(c => c.getMultipleAccountsInfo([...keys, ...uKeys]));
  const [bm, qm, pb, pq] = infos;
  if (!bm || !qm || !pb || !pq) throw http(502, 'Pool accounts are missing.');
  const baseTokenProgram = bm.owner, quoteTokenProgram = qm.owner;
  const baseMintAccount = MintLayout.decode(bm.data.slice(0, MintLayout.span));
  const quoteDecimals = MintLayout.decode(qm.data.slice(0, MintLayout.span)).decimals;
  const poolBaseTokenAccount = AccountLayout.decode(pb.data.slice(0, AccountLayout.span));
  const poolQuoteTokenAccount = AccountLayout.decode(pq.data.slice(0, AccountLayout.span));
  const Rb = big(poolBaseTokenAccount.amount), Rq = big(poolQuoteTokenAccount.amount), L = big(pool.lpSupply);
  const fee = feesFor(pool, globalConfig, feeConfig, baseMintAccount.supply, Rb, Rq);
  const st = {
    globalConfig, feeConfig, poolKey, poolInfo, pool, baseTokenProgram, quoteTokenProgram, baseMintAccount,
    poolBaseTokenAccount, poolQuoteTokenAccount, Rb, Rq, L, vqr: big(pool.virtualQuoteReserves), fee,
    decimals: baseMintAccount.decimals, quoteDecimals, supply: big(baseMintAccount.supply),
  };
  if (user) {
    const [ua, ub1, ub2, uq1, uq2, ulp] = infos.slice(4);
    const b22 = baseTokenProgram.equals(TOKEN_2022_PROGRAM_ID), q22 = quoteTokenProgram.equals(TOKEN_2022_PROGRAM_ID);
    const owned = (info, prog) => (info && info.owner.equals(prog) ? info : null);
    const amt = info => (info ? big(AccountLayout.decode(info.data.slice(0, AccountLayout.span)).amount) : 0n);
    st.u = {
      user, lamports: BigInt(ua ? ua.lamports : 0),
      userBaseTokenAccount: b22 ? uKeys[2] : uKeys[1], userBaseAccountInfo: owned(b22 ? ub2 : ub1, baseTokenProgram),
      userQuoteTokenAccount: q22 ? uKeys[4] : uKeys[3], userQuoteAccountInfo: owned(q22 ? uq2 : uq1, quoteTokenProgram),
      userPoolTokenAccount: uKeys[5], userPoolAccountInfo: owned(ulp, TOKEN_2022_PROGRAM_ID),
    };
    st.u.base = amt(st.u.userBaseAccountInfo); st.u.quote = amt(st.u.userQuoteAccountInfo); st.u.lp = amt(st.u.userPoolAccountInfo);
  }
  return st;
}
function swapState(st) {
  return {
    globalConfig: st.globalConfig, feeConfig: st.feeConfig, poolKey: st.poolKey,
    // a full-size copy so the SDK never adds a second extend_account (we add one ourselves)
    poolAccountInfo: { ...st.poolInfo, data: Buffer.alloc(Math.max(st.poolInfo.data.length, POOL_ACCOUNT_NEW_SIZE)) },
    pool: st.pool, poolBaseAmount: new BN(st.Rb.toString()), poolQuoteAmount: new BN(st.Rq.toString()),
    baseTokenProgram: st.baseTokenProgram, quoteTokenProgram: st.quoteTokenProgram, baseMint: st.pool.baseMint,
    baseMintAccount: st.baseMintAccount, user: st.u.user, userBaseTokenAccount: st.u.userBaseTokenAccount,
    userQuoteTokenAccount: st.u.userQuoteTokenAccount, userBaseAccountInfo: st.u.userBaseAccountInfo,
    userQuoteAccountInfo: st.u.userQuoteAccountInfo,
  };
}
function liqState(st) {
  return {
    globalConfig: st.globalConfig, poolKey: st.poolKey,
    poolAccountInfo: { ...st.poolInfo, data: Buffer.alloc(Math.max(st.poolInfo.data.length, POOL_ACCOUNT_NEW_SIZE)) },
    pool: st.pool, poolBaseTokenAccount: st.poolBaseTokenAccount, poolQuoteTokenAccount: st.poolQuoteTokenAccount,
    baseTokenProgram: st.baseTokenProgram, quoteTokenProgram: st.quoteTokenProgram, user: st.u.user,
    userBaseTokenAccount: st.u.userBaseTokenAccount, userQuoteTokenAccount: st.u.userQuoteTokenAccount,
    userPoolTokenAccount: st.u.userPoolTokenAccount, userBaseAccountInfo: st.u.userBaseAccountInfo,
    userQuoteAccountInfo: st.u.userQuoteAccountInfo, userPoolAccountInfo: st.u.userPoolAccountInfo,
  };
}
// From the SDK's instruction lists keep only the PumpSwap instruction and any non-wSOL ATA creation;
// the wSOL wrap/unwrap is done once for the whole transaction.
function keep(ixs) {
  return ixs.filter(ix => {
    if (ix.programId.equals(PUMP_AMM_PROGRAM_ID)) return true;
    if (ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) return !ix.keys[3].pubkey.equals(NATIVE_MINT);
    return false;
  });
}

/* ---------------- the math ---------------- */
// Cost of buying exactly b base (mirrors pump-amm buy): quote in, LP fee (stays in the pool), total paid.
function buyCost(st, b) {
  const Rqe = st.Rq + st.vqr;
  if (b <= 0n) return { q: 0n, lpFee: 0n, total: 0n };
  if (b >= st.Rb) return { q: U64_MAX, lpFee: 0n, total: U64_MAX };
  const q = ceilDiv(Rqe * b, st.Rb - b);
  const f = bps => ceilDiv(q * bps, 10000n);
  return { q, lpFee: f(st.fee.lp), total: q + f(st.fee.lp) + f(st.fee.pr) + f(st.fee.cr) };
}
// Split a SOL budget into "buy b of the coin" + "deposit both sides" so nothing is left over.
function planAdd(st, budget, slipBps) {
  let lo = 0n, hi = st.Rb / 2n;
  for (let i = 0; i < 90 && hi - lo > 1n; i++) {
    const mid = (lo + hi) / 2n; const c = buyCost(st, mid);
    if (c.total >= budget) { hi = mid; continue; }
    const D = budget - c.total; const Rb2 = st.Rb - mid, Rq2 = st.Rq + c.q + c.lpFee;
    if (mid * Rq2 < D * Rb2) lo = mid; else hi = mid;
  }
  const b = lo, c = buyCost(st, b);
  if (b <= 0n || c.total >= budget) throw http(400, 'That amount is too small for this pool.');
  const D = budget - c.total, Rb2 = st.Rb - b, Rq2 = st.Rq + c.q + c.lpFee;
  let lp = b * st.L / Rb2; const lpQ = D * st.L / Rq2; if (lpQ < lp) lp = lpQ;
  lp = lp * (10000n - slipBps) / 10000n;
  if (lp <= 0n) throw http(400, 'That amount is too small for this pool.');
  let maxBuy = c.total * (10000n + slipBps) / 10000n; if (maxBuy > budget) maxBuy = budget;
  return {
    baseOut: b, buyCost: c.total, maxBuy, lp, maxBase: b, maxQuoteDep: D,
    depBase: ceilDiv(Rb2 * lp, st.L), depQuote: ceilDiv(Rq2 * lp, st.L), share: Number(lp) / Number(st.L + lp),
  };
}

/* ---------------- transactions ---------------- */
async function priorityFee(keys) {
  try {
    const r = await cached('prio:' + (keys[0] ? keys[0].toBase58() : ''), 20000, () => rpc(c => c.getRecentPrioritizationFees(keys.length ? { lockedWritableAccounts: keys.slice(0, 1) } : undefined)));
    const v = r.map(x => x.prioritizationFee).filter(x => x > 0).sort((a, b) => a - b);
    const p = v.length ? v[Math.floor(v.length * 0.7)] : 60000;
    return Math.max(25000, Math.min(1500000, p));
  } catch (e) { return 60000; }
}
async function compile(user, ixs, cu, price, blockhash) {
  const tables = await lookupTables();
  const all = [ComputeBudgetProgram.setComputeUnitLimit({ units: cu }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price }), ...ixs];
  const msg = new TransactionMessage({ payerKey: user, recentBlockhash: blockhash, instructions: all }).compileToV0Message(tables);
  const tx = new VersionedTransaction(msg);
  try { const bytes = tx.serialize(); return bytes.length <= 1232 ? { tx, bytes } : null; } catch (e) { return null; }
}
function explain(sim) {
  const logs = (sim && sim.logs) || [];
  const m = JSON.stringify(sim && sim.err || '').match(/"Custom":(\d+)/);
  if (m && ERRORS[m[1]]) return ERRORS[m[1]];
  const l = logs.join('\n');
  if (/insufficient lamports|insufficient funds/i.test(l)) return 'Not enough SOL in the wallet for this, including network fees and rent.';
  if (/ExceededSlippage|slippage/i.test(l)) return ERRORS[6004];
  if (m) return 'PumpSwap rejected it (error ' + m[1] + ').';
  return 'The transaction would fail: ' + JSON.stringify(sim && sim.err).slice(0, 120);
}
// Compile, simulate once at a high limit, then set the real limit. Splits into two txs only if needed.
async function finish(user, groups, simulateIdx = 0, poolKey = null) {
  const { blockhash, lastValidBlockHeight } = await rpc(c => c.getLatestBlockhash('confirmed'));
  const price = await priorityFee(poolKey ? [poolKey] : []);
  const out = [];
  for (let i = 0; i < groups.length; i++) {
    const first = await compile(user, groups[i], 1_000_000, price, blockhash);
    if (!first) throw http(500, 'Transaction too large');
    let units = 400000, sim = null;
    if (i === simulateIdx) {
      const r = await rpc(c => c.simulateTransaction(first.tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'processed' }));
      sim = r.value;
      if (sim.err) { const e = http(400, explain(sim)); e.logs = (sim.logs || []).slice(-12); throw e; }
      units = Math.min(1_400_000, Math.ceil((sim.unitsConsumed || 300000) * 1.2) + 15000);
    } else units = 300000;
    const fin = await compile(user, groups[i], units, price, blockhash);
    out.push({ tx: Buffer.from(fin.bytes).toString('base64'), bytes: fin.bytes.length, units, sim: sim ? { units: sim.unitsConsumed } : null });
  }
  return { txs: out, blockhash, lastValidBlockHeight, priorityMicroLamports: price };
}
async function fits(user, ixs) {
  const r = await compile(user, ixs, 400000, 50000, '11111111111111111111111111111111');
  return !!r;
}
function wsolOpen(user, lamports) {
  const ata = getAssociatedTokenAddressSync(NATIVE_MINT, user, true, TOKEN_PROGRAM_ID);
  const ixs = [createAssociatedTokenAccountIdempotentInstruction(user, ata, user, NATIVE_MINT, TOKEN_PROGRAM_ID)];
  if (lamports > 0n) ixs.push(SystemProgram.transfer({ fromPubkey: user, toPubkey: ata, lamports }), createSyncNativeInstruction(ata, TOKEN_PROGRAM_ID));
  return ixs;
}
const wsolClose = user => createCloseAccountInstruction(getAssociatedTokenAddressSync(NATIVE_MINT, user, true, TOKEN_PROGRAM_ID), user, user, [], TOKEN_PROGRAM_ID);
function jugIx(user, lamports) {
  if (!CONFIG.jug || lamports <= 0n) return [];
  return [SystemProgram.transfer({ fromPubkey: user, toPubkey: new PublicKey(CONFIG.jug), lamports })];
}
const slipOf = v => { const n = Math.max(0.3, Math.min(15, Number(v) || 2)); return BigInt(Math.round(n * 100)); };
const RENT_ATA = 2039280n, RENT_ATA22 = 2074080n;

async function buildAdd(b) {
  const user = pk(b.user, 'wallet'), poolKey = pk(b.pool, 'pool');
  const lamports = BigInt(Math.floor(Number(b.sol) * 1e9));
  if (!(lamports >= 10_000_000n)) throw http(400, 'Add at least 0.01 SOL.');
  const st = await loadState(poolKey, user);
  if (!st.pool.quoteMint.equals(NATIVE_MINT)) throw http(400, 'One-click adds work on SOL pools only.');
  const slip = slipOf(b.slippage);
  const fee = CONFIG.jug ? lamports * BigInt(CONFIG.feeBps) / 10000n : 0n;
  const budget = lamports - fee;
  const rent = (st.u.userBaseAccountInfo ? 0n : RENT_ATA) + (st.u.userPoolAccountInfo ? 0n : RENT_ATA22) + RENT_ATA + 120000n;
  if (st.u.lamports < lamports + rent) throw http(400, `Not enough SOL. This needs about ${sol(lamports + rent).toFixed(4)} SOL including rent for new token accounts and fees; the wallet has ${sol(st.u.lamports).toFixed(4)}.`);
  const plan = planAdd(st, budget, slip);
  // cross-check the buy price with the SDK's own quote
  const sdkQuote = buyBaseInput({ base: new BN(plan.baseOut.toString()), slippage: Number(slip) / 100, baseReserve: new BN(st.Rb.toString()), quoteReserve: new BN(st.Rq.toString()), virtualQuoteReserves: st.pool.virtualQuoteReserves, globalConfig: st.globalConfig, baseMintAccount: st.baseMintAccount, baseMint: st.pool.baseMint, coinCreator: st.pool.coinCreator, creator: st.pool.creator, feeConfig: st.feeConfig, quoteMint: st.pool.quoteMint, isMayhemMode: st.pool.isMayhemMode, creatorFeeBps: st.pool.creatorFeeBps });
  const sdkTotal = big(sdkQuote.uiQuote);
  if (sdkTotal > plan.buyCost) { plan.buyCost = sdkTotal; plan.maxBuy = sdkTotal * (10000n + slip) / 10000n; if (plan.maxBuy > budget) plan.maxBuy = budget; }
  const extend = st.poolInfo.data.length < POOL_ACCOUNT_NEW_SIZE ? [await PUMP_AMM_SDK.extendAccount(poolKey, user)] : [];
  const buy = keep(await PUMP_AMM_SDK.buyInstructions(swapState(st), new BN(plan.baseOut.toString()), new BN(plan.maxBuy.toString())));
  const dep = keep(await PUMP_AMM_SDK.depositInstructionsInternal(liqState(st), new BN(plan.lp.toString()), new BN(plan.maxBase.toString()), new BN(plan.maxQuoteDep.toString())));
  const one = [...jugIx(user, fee), ...extend, ...wsolOpen(user, budget), ...buy, ...dep, wsolClose(user)];
  let groups;
  if (await fits(user, one)) groups = [one];
  else groups = [
    [...jugIx(user, fee), ...extend, ...wsolOpen(user, plan.maxBuy), ...buy, wsolClose(user)],
    [...wsolOpen(user, plan.maxQuoteDep), ...dep, wsolClose(user)],
  ];
  const built = await finish(user, groups, 0, poolKey);
  return {
    ...built, kind: 'add', pool: poolKey.toBase58(),
    quote: {
      sol: sol(lamports), jug: sol(fee), jugBps: CONFIG.jug ? CONFIG.feeBps : 0, swapSol: sol(plan.buyCost), coinOut: plan.baseOut.toString(),
      decimals: st.decimals, depositSol: sol(plan.depQuote), depositCoin: plan.depBase.toString(), lp: plan.lp.toString(),
      share: plan.share, slippagePct: Number(slip) / 100, lpFeeBps: Number(st.fee.lp), steps: groups.length,
    },
  };
}

async function buildAdd2(b) {
  // two-sided: the coin the wallet already holds + the matching SOL
  const user = pk(b.user, 'wallet'), poolKey = pk(b.pool, 'pool');
  const st = await loadState(poolKey, user);
  if (!st.pool.quoteMint.equals(NATIVE_MINT)) throw http(400, 'SOL pools only.');
  const slip = slipOf(b.slippage);
  let base = b.coin === 'max' || b.coin == null ? st.u.base : BigInt(String(b.coin));
  if (base > st.u.base) base = st.u.base;
  if (base <= 0n) throw http(400, 'This wallet holds none of this coin.');
  // LP from the coin side, with room for the price to move
  let lp = base * st.L / st.Rb * (10000n - slip) / 10000n;
  let needQ = ceilDiv(st.Rq * lp, st.L);
  const maxQ = needQ * (10000n + slip) / 10000n;
  const valueSol = needQ * 2n;
  const fee = CONFIG.jug ? valueSol * BigInt(CONFIG.feeBps) / 10000n : 0n;
  const rent = (st.u.userPoolAccountInfo ? 0n : RENT_ATA22) + RENT_ATA + 100000n;
  if (st.u.lamports < maxQ + fee + rent) {
    // scale down to the SOL the wallet has
    const avail = st.u.lamports - fee - rent;
    if (avail <= 1000000n) throw http(400, 'Not enough SOL to pair with the coin.');
    lp = lp * avail / maxQ; needQ = ceilDiv(st.Rq * lp, st.L);
  }
  const maxBase = ceilDiv(st.Rb * lp, st.L) * (10000n + slip) / 10000n;
  const mb = maxBase > st.u.base ? st.u.base : maxBase;
  const mq = needQ * (10000n + slip) / 10000n;
  const dep = keep(await PUMP_AMM_SDK.depositInstructionsInternal(liqState(st), new BN(lp.toString()), new BN(mb.toString()), new BN(mq.toString())));
  const extend = st.poolInfo.data.length < POOL_ACCOUNT_NEW_SIZE ? [await PUMP_AMM_SDK.extendAccount(poolKey, user)] : [];
  const built = await finish(user, [[...jugIx(user, fee), ...extend, ...wsolOpen(user, mq), ...dep, wsolClose(user)]], 0, poolKey);
  return { ...built, kind: 'add2', pool: poolKey.toBase58(), quote: { depositSol: sol(needQ), depositCoin: ceilDiv(st.Rb * lp, st.L).toString(), decimals: st.decimals, jug: sol(fee), lp: lp.toString(), share: Number(lp) / Number(st.L + lp), steps: 1 } };
}

async function buildRemove(b) {
  const user = pk(b.user, 'wallet'), poolKey = pk(b.pool, 'pool');
  const st = await loadState(poolKey, user);
  if (st.u.lp <= 0n) throw http(400, 'This wallet has no liquidity in this pool.');
  const pct = Math.max(1, Math.min(100, Number(b.pct) || 100));
  const lp = pct === 100 ? st.u.lp : st.u.lp * BigInt(Math.round(pct * 100)) / 10000n;
  if (lp <= 0n) throw http(400, 'Nothing to withdraw.');
  const slip = slipOf(b.slippage);
  const base = st.Rb * lp / st.L, quote = st.Rq * lp / st.L;
  const minBase = base * (10000n - slip) / 10000n, minQuote = quote * (10000n - slip) / 10000n;
  const wd = keep(await PUMP_AMM_SDK.withdrawInstructionsInternal(liqState(st), new BN(lp.toString()), new BN(minBase.toString()), new BN(minQuote.toString())));
  const extend = st.poolInfo.data.length < POOL_ACCOUNT_NEW_SIZE ? [await PUMP_AMM_SDK.extendAccount(poolKey, user)] : [];
  const toSol = !!b.toSol && st.pool.quoteMint.equals(NATIVE_MINT);
  let groups, sellOut = 0n;
  if (!toSol) groups = [[...extend, ...wsolOpen(user, 0n), ...wd, wsolClose(user)]];
  else {
    const q = sellBaseInput({ base: new BN(minBase.toString()), slippage: Number(slip) / 100, baseReserve: new BN((st.Rb - base).toString()), quoteReserve: new BN((st.Rq - quote).toString()), virtualQuoteReserves: st.pool.virtualQuoteReserves, globalConfig: st.globalConfig, baseMintAccount: st.baseMintAccount, baseMint: st.pool.baseMint, coinCreator: st.pool.coinCreator, creator: st.pool.creator, feeConfig: st.feeConfig, quoteMint: st.pool.quoteMint, isMayhemMode: st.pool.isMayhemMode, creatorFeeBps: st.pool.creatorFeeBps });
    sellOut = big(q.uiQuote);
    const sst = swapState(st);
    // the base ATA will exist after the withdraw
    if (!sst.userBaseAccountInfo) sst.userBaseAccountInfo = { owner: st.baseTokenProgram, data: Buffer.alloc(165), lamports: 1, executable: false };
    const sell = keep(await PUMP_AMM_SDK.sellInstructions(sst, new BN(minBase.toString()), new BN(q.minQuote.toString())));
    const one = [...extend, ...wsolOpen(user, 0n), ...wd, ...sell, wsolClose(user)];
    if (await fits(user, one)) groups = [one];
    else groups = [[...extend, ...wsolOpen(user, 0n), ...wd, wsolClose(user)], [...wsolOpen(user, 0n), ...sell, wsolClose(user)]];
  }
  const built = await finish(user, groups, 0, poolKey);
  return { ...built, kind: 'remove', pool: poolKey.toBase58(), quote: { pct, lp: lp.toString(), coinOut: base.toString(), solOut: sol(quote), sellSol: sol(sellOut), toSol, decimals: st.decimals, steps: groups.length } };
}

/* ---------------- market data ---------------- */
async function dexMeta(mints) {
  const out = {};
  await Promise.all(chunk(mints, 30).map(async part => {
    try {
      const j = await getJson('https://api.dexscreener.com/tokens/v1/solana/' + part.join(','));
      for (const p of (Array.isArray(j) ? j : [])) {
        if (p.chainId !== 'solana') continue;
        out[p.pairAddress] = p;
        const m = p.baseToken && p.baseToken.address; if (m && !out['m:' + m]) out['m:' + m] = p;
      }
    } catch (e) { }
  }));
  return out;
}
function chunk(a, n) { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; }
function solUsdFrom(meta) {
  const v = Object.values(meta).filter(p => p && p.quoteToken && p.quoteToken.symbol === 'SOL' && +p.priceNative > 0 && +p.priceUsd > 0).map(p => +p.priceUsd / +p.priceNative).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : null;
}
function cow(poolKey, pool, Rb, Rq, supply, decimals, fee, p, solUsd) {
  const tvlSol = 2 * sol(Rq);
  const volUsd = p && p.volume ? +p.volume.h24 || 0 : 0;
  const volSol = solUsd ? volUsd / solUsd : 0;
  const milk = tvlSol > 0 ? volSol * Number(fee.lp) / 10000 / tvlSol : 0;
  const mcapSol = Rb > 0n ? sol(Rq * supply / Rb) : 0;
  return {
    pool: poolKey, mint: pool.baseMint.toBase58(), name: p && p.baseToken ? p.baseToken.name : '', symbol: p && p.baseToken ? p.baseToken.symbol : '',
    image: p && p.info && p.info.imageUrl ? p.info.imageUrl : '', tvlSol, volSol, volUsd, lpBps: Number(fee.lp),
    totalBps: Number(fee.lp + fee.pr + fee.cr), milkPerSolDay: milk, apr: milk * 365, mcapSol,
    change24: p && p.priceChange ? +p.priceChange.h24 || 0 : 0, txns24: p && p.txns && p.txns.h24 ? (p.txns.h24.buys || 0) + (p.txns.h24.sells || 0) : 0,
    created: p && p.pairCreatedAt ? p.pairCreatedAt : null, decimals,
  };
}
async function candidateMints() {
  const gt = 'https://api.geckoterminal.com/api/v2/networks/solana/';
  const srcs = [
    gt + 'trending_pools?include=base_token,dex&page=1', gt + 'trending_pools?include=base_token,dex&page=2',
    gt + 'dexes/pumpswap/pools?page=1', gt + 'dexes/pumpswap/pools?page=2', gt + 'dexes/pumpswap/pools?page=3',
    gt + 'new_pools?include=base_token,dex&page=1',
    'https://api.dexscreener.com/token-boosts/top/v1', 'https://api.dexscreener.com/token-boosts/latest/v1',
    'https://api.dexscreener.com/token-profiles/latest/v1',
  ];
  const mints = new Set();
  await Promise.all(srcs.map(async u => {
    try {
      const j = await getJson(u, 6500);
      if (Array.isArray(j)) { for (const t of j) if (t.chainId === 'solana' && t.tokenAddress) mints.add(t.tokenAddress); return; }
      for (const p of (j.data || [])) {
        const dex = p.relationships && p.relationships.dex && p.relationships.dex.data ? p.relationships.dex.data.id : 'pumpswap';
        if (dex !== 'pumpswap') continue;
        const id = p.relationships && p.relationships.base_token && p.relationships.base_token.data ? p.relationships.base_token.data.id : '';
        if (id.startsWith('solana_')) mints.add(id.slice(7));
      }
    } catch (e) { }
  }));
  if (CONFIG.ca) mints.add(CONFIG.ca);
  return [...mints].filter(m => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(m)).slice(0, 400);
}
async function pools() {
  return cached('pools', 90000, async () => {
    const { globalConfig, feeConfig } = await globals();
    const mints = await candidateMints();
    const keys = []; for (const m of mints) { try { keys.push([m, canonicalPumpPoolPda(new PublicKey(m))]); } catch (e) { } }
    const infos = await multi(keys.map(k => k[1]));
    const live = [];
    infos.forEach((info, i) => { if (info && info.owner.equals(PUMP_AMM_PROGRAM_ID)) { try { live.push({ key: keys[i][1], pool: PUMP_AMM_SDK.decodePool(info) }); } catch (e) { } } });
    const acc = await multi(live.flatMap(x => [x.pool.baseMint, x.pool.poolBaseTokenAccount, x.pool.poolQuoteTokenAccount]));
    const meta = await dexMeta(live.map(x => x.pool.baseMint.toBase58()));
    const solUsd = solUsdFrom(meta) || 0;
    const out = [];
    live.forEach((x, i) => {
      const [mi, bi, qi] = acc.slice(i * 3, i * 3 + 3);
      if (!mi || !bi || !qi) return;
      try {
        const mint = MintLayout.decode(mi.data.slice(0, MintLayout.span));
        const Rb = big(AccountLayout.decode(bi.data.slice(0, AccountLayout.span)).amount), Rq = big(AccountLayout.decode(qi.data.slice(0, AccountLayout.span)).amount);
        if (Rb === 0n || Rq === 0n) return;
        const fee = feesFor(x.pool, globalConfig, feeConfig, mint.supply, Rb, Rq);
        const p = meta[x.key.toBase58()] || null;
        const c = cow(x.key.toBase58(), x.pool, Rb, Rq, big(mint.supply), mint.decimals, fee, p, solUsd);
        if (c.tvlSol < MIN_TVL_SOL || !p) return;
        out.push(c);
      } catch (e) { }
    });
    out.sort((a, b) => b.milkPerSolDay - a.milkPerSolDay);
    return { solUsd, count: out.length, checked: mints.length, updated: Date.now(), pools: out.slice(0, 80) };
  });
}
async function poolOne(id, userStr) {
  let key = pk(id, 'address');
  const info = await rpc(c => c.getAccountInfo(key));
  if (!info || !info.owner.equals(PUMP_AMM_PROGRAM_ID)) {
    // treat it as a coin: its canonical SOL pool
    key = canonicalPumpPoolPda(key);
  }
  const user = userStr ? pk(userStr, 'wallet') : null;
  let st;
  try { st = await loadState(key, user); } catch (e) { if (e.code === 404) throw http(404, 'No PumpSwap SOL pool for that address yet. Coins still on the bonding curve have no pool.'); throw e; }
  const meta = await dexMeta([st.pool.baseMint.toBase58()]);
  const p = meta[key.toBase58()] || meta['m:' + st.pool.baseMint.toBase58()] || null;
  const solUsd = solUsdFrom(meta) || (await pools().catch(() => ({ solUsd: 0 }))).solUsd || 0;
  const c = cow(key.toBase58(), st.pool, st.Rb, st.Rq, st.supply, st.decimals, st.fee, p && p.pairAddress === key.toBase58() ? p : null, solUsd);
  if (!c.name && p && p.baseToken) { c.name = p.baseToken.name; c.symbol = p.baseToken.symbol; c.image = p.info && p.info.imageUrl || ''; }
  const out = { ...c, solPool: st.pool.quoteMint.equals(NATIVE_MINT), reserves: { coin: st.Rb.toString(), sol: sol(st.Rq), solLamports: st.Rq.toString(), vqr: st.vqr.toString() }, lpSupply: st.L.toString(), feeBps: { lp: Number(st.fee.lp), protocol: Number(st.fee.pr), creator: Number(st.fee.cr) }, solUsd };
  if (st.u) {
    const share = st.L > 0n ? Number(st.u.lp) / Number(st.L) : 0;
    out.you = { sol: sol(st.u.lamports), coin: st.u.base.toString(), lp: st.u.lp.toString(), share, valueSol: share * 2 * sol(st.Rq), coinInPool: st.L > 0n ? (st.Rb * st.u.lp / st.L).toString() : '0', solInPool: st.L > 0n ? sol(st.Rq * st.u.lp / st.L) : 0 };
  }
  return out;
}
async function positions(userStr) {
  const user = pk(userStr, 'wallet');
  const res = await rpc(c => c.getParsedTokenAccountsByOwner(user, { programId: TOKEN_2022_PROGRAM_ID }));
  const held = res.value.map(a => a.account.data.parsed.info).filter(i => i.tokenAmount && i.tokenAmount.amount !== '0');
  if (!held.length) return { positions: [] };
  const mintKeys = held.map(i => new PublicKey(i.mint));
  const mintInfos = await multi(mintKeys);
  const cands = mintInfos.map(mi => { if (!mi) return null; const m = MintLayout.decode(mi.data.slice(0, MintLayout.span)); return m.mintAuthorityOption ? m.mintAuthority : null; });
  const idx = cands.map((c, i) => [c, i]).filter(x => x[0]);
  const poolInfos = await multi(idx.map(x => x[0]));
  const found = [];
  poolInfos.forEach((info, j) => {
    if (!info || !info.owner.equals(PUMP_AMM_PROGRAM_ID)) return;
    try { const pool = PUMP_AMM_SDK.decodePool(info); const i = idx[j][1]; if (pool.lpMint.equals(mintKeys[i])) found.push({ key: idx[j][0], pool, lp: BigInt(held[i].tokenAmount.amount) }); } catch (e) { }
  });
  if (!found.length) return { positions: [] };
  const acc = await multi(found.flatMap(x => [x.pool.baseMint, x.pool.poolBaseTokenAccount, x.pool.poolQuoteTokenAccount]));
  const meta = await dexMeta(found.map(x => x.pool.baseMint.toBase58()));
  const solUsd = solUsdFrom(meta) || 0;
  const { globalConfig, feeConfig } = await globals();
  const out = [];
  found.forEach((x, i) => {
    const [mi, bi, qi] = acc.slice(i * 3, i * 3 + 3); if (!mi || !bi || !qi) return;
    const mint = MintLayout.decode(mi.data.slice(0, MintLayout.span));
    const Rb = big(AccountLayout.decode(bi.data.slice(0, AccountLayout.span)).amount), Rq = big(AccountLayout.decode(qi.data.slice(0, AccountLayout.span)).amount);
    const L = big(x.pool.lpSupply); if (L === 0n) return;
    const fee = feesFor(x.pool, globalConfig, feeConfig, mint.supply, Rb, Rq);
    const p = meta[x.key.toBase58()] || null;
    const c = cow(x.key.toBase58(), x.pool, Rb, Rq, big(mint.supply), mint.decimals, fee, p, solUsd);
    if (!c.name && meta['m:' + c.mint]) { const q = meta['m:' + c.mint]; c.name = q.baseToken.name; c.symbol = q.baseToken.symbol; c.image = q.info && q.info.imageUrl || ''; }
    const share = Number(x.lp) / Number(L);
    out.push({ ...c, lp: x.lp.toString(), share, valueSol: share * 2 * sol(Rq), coinInPool: (Rb * x.lp / L).toString(), solInPool: sol(Rq * x.lp / L), milkDaySol: share * c.volSol * c.lpBps / 10000, solPool: x.pool.quoteMint.equals(NATIVE_MINT) });
  });
  out.sort((a, b) => b.valueSol - a.valueSol);
  return { positions: out, solUsd };
}

/* =====================================================================================
 * NULL: life on PumpSwap
 *
 * A pump.fun coin is "declared" while it rides its bonding curve, "assigned" the moment it
 * graduates to PumpSwap, and alive for as long as its pool keeps moving. 72 hours without a
 * single transaction on its pool and it returns null. Everything below is read from Solana
 * (and DexScreener for names and prices); nothing is simulated.
 * ===================================================================================== */
const zlib = require('zlib');
const crypto = require('crypto');
const PUMP = require('@pump-fun/pump-sdk');
const MIGRATOR = new PublicKey('39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg'); // pump.fun's migration wallet: one tx per graduation
const PUMP_PROGRAM = PUMP.PUMP_PROGRAM_ID;
const TTL = 72 * 3600; // seconds of silence before a coin returns null
const nowS = () => Math.floor(Date.now() / 1000);
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

async function mapLimit(items, n, fn, deadline) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; if (deadline && Date.now() > deadline) { out[k] = undefined; continue; } try { out[k] = await fn(items[k], k); } catch (e) { out[k] = null; } }
  }));
  return out;
}
const sigs = (addr, opt) => rpc(c => c.getSignaturesForAddress(addr, opt, 'confirmed'));
// deep history: publicnode keeps about a day of signatures, so older pages fall through to the next RPC (mainnet-beta keeps it all)
async function sigsDeep(addr, opt, diag) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let empty = null;
    for (let i = 0; i < conns.length; i++) {
      try { if (i) await slot('sig' + i, 280); const r = await conns[i].getSignaturesForAddress(addr, opt, 'confirmed'); if (r.length) return r; empty = r; }
      catch (e) { if (diag && diag.length < 8) diag.push(i + ': ' + String(e && e.message || e).replace(/https?:\/\/\S+/g, '').slice(0, 70)); }
    }
    if (empty) return empty;
    await new Promise(r => setTimeout(r, 700 * (attempt + 1)));
  }
  return null;
}

// A transaction from any RPC that still has it (publicnode forgets after about a day).
// fallback RPCs (mainnet-beta) allow only a few calls a second per method: space them out
const gate = {};
async function slot(key, gap) { const now = Date.now(), next = Math.max(now, gate[key] || 0); gate[key] = next + gap; if (next > now) await new Promise(r => setTimeout(r, next - now)); }
async function rpcRaw(i, method, params) {
  const r = await timedFetch(9000)(RPCS[i], { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || j.error) throw new Error((j && j.error && j.error.message) || ('HTTP ' + r.status));
  return j.result;
}
// raw getTransaction: older pump migrations are version-1 transactions that web3.js refuses to decode
async function txDeep(sig, diag) {
  for (let attempt = 0; attempt < 3; attempt++) {
    for (let i = 0; i < RPCS.length; i++) {
      for (const v of [0, 1]) {
        try {
          if (i) await slot('tx' + i, 260);
          const t1 = Date.now();
          const t = await rpcRaw(i, 'getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: v, commitment: 'confirmed' }]);
          if (diag && i && diag.length < 10) diag.push(`tx${i} v${v} ${Date.now() - t1}ms ${t ? 'ok' : 'null'}`);
          if (t) return t;
          break;
        } catch (e) {
          const m = String(e && e.message || e);
          if (v === 0 && /version/i.test(m)) continue;
          if (diag && i && diag.length < 6) diag.push('tx' + i + ': ' + m.replace(/https?:\/\/\S+/g, '').slice(0, 90));
          break;
        }
      }
    }
    await new Promise(r => setTimeout(r, 900 * (attempt + 1)));
  }
  throw new Error('transaction unavailable');
}
// The coin a migration transaction graduated (account 2 of pump's migrate instruction). false = not a migration.
async function migratedMint(sig, diag) {
  return cached('mig:' + sig, 864e5, async () => {
    const t = await txDeep(sig, diag);
    if (t.meta && t.meta.err) return false;
    const logs = (t.meta && t.meta.logMessages) || [];
    if (!logs.some(l => /Instruction: Migrate/.test(l))) return false;
    const P = PUMP_PROGRAM.toBase58();
    const ix = ((t.transaction && t.transaction.message && t.transaction.message.instructions) || []).find(i => String(i.programId) === P);
    if (!ix || !ix.accounts || ix.accounts.length < 3) return false;
    const m = ix.accounts[2]; const mint = typeof m === 'string' ? m : (m && m.pubkey) || String(m);
    return B58.test(mint) ? { mint, at: t.blockTime || 0 } : false;
  });
}
// The last moment anything touched a pool: its heartbeat.
async function lastBeat(poolKey) {
  const s = await sigsDeep(poolKey, { limit: 8 });
  if (!s) throw new Error('rpc busy');
  const ok = s.find(x => !x.err && x.blockTime) || s.find(x => x.blockTime);
  return ok ? ok.blockTime : null;
}
function vitals(bornAt, lastAt) {
  const t = nowS();
  const silence = lastAt ? Math.max(0, t - lastAt) : null;
  const state = silence == null ? 'unknown' : silence >= TTL ? 'null' : 'alive';
  return { bornAt: bornAt || null, lastAt: lastAt || null, silence, ttl: silence == null ? null : Math.max(0, TTL - silence), uptime: state === 'null' && lastAt && bornAt ? Math.max(0, lastAt - bornAt) : (bornAt ? t - bornAt : null), state };
}
function metaOf(meta, mint, poolKey) {
  const p = (poolKey && meta[poolKey]) || meta['m:' + mint] || null;
  if (!p) return {};
  return {
    name: p.baseToken ? p.baseToken.name : '', symbol: p.baseToken ? p.baseToken.symbol : '', image: p.info && p.info.imageUrl || '',
    mcap: +p.marketCap || +p.fdv || null, price: +p.priceUsd || null, vol24: p.volume ? +p.volume.h24 || 0 : 0,
    txns24: p.txns && p.txns.h24 ? (p.txns.h24.buys || 0) + (p.txns.h24.sells || 0) : 0, change24: p.priceChange ? +p.priceChange.h24 || 0 : 0,
    pairCreatedAt: p.pairCreatedAt ? Math.floor(p.pairCreatedAt / 1000) : null, dex: p.dexId || '',
  };
}

/* ---------------- the census: a measured sample of every graduation in the last 7 days ---------------- */
const COHORTS = [[0, 6, '0–6h', 12], [6, 24, '6–24h', 12], [24, 48, '1–2d', 8], [48, 72, '2–3d', 8], [72, 120, '3–5d', 24]];
async function census() {
  return cached('census', 15 * 60e3, async () => {
    const t0 = Date.now(), now = nowS(), HORIZON = 5 * 86400, deadline = t0 + 56000;
    // 1) every migration signature back to 7 days (signatures only: cheap)
    let before, all = [], reached = now, pages = 0; const diag = [];
    while (pages < 20 && Date.now() - t0 < 15000) {
      const page = await sigsDeep(MIGRATOR, { limit: 1000, before }, diag);
      pages++;
      if (!page) { if (!all.length) throw http(502, 'Solana RPC is busy: ' + diag.join(' | ')); break; }
      if (!page.length) break;
      for (const s of page) if (!s.err && s.blockTime) all.push(s);
      before = page[page.length - 1].signature; reached = page[page.length - 1].blockTime || reached;
      if (reached < now - HORIZON) break;
    }
    all = all.filter(s => s.blockTime >= now - HORIZON);
    const coveredH = (now - Math.max(reached, now - HORIZON)) / 3600;
    // 2) an even sample from each age band
    const picks = [];
    COHORTS.forEach(([a, b, , PER], ci) => {
      if (a >= coveredH) return;
      const band = all.filter(s => now - s.blockTime >= a * 3600 && now - s.blockTime < b * 3600);
      const step = Math.max(1, Math.floor(band.length / PER));
      for (let i = 0; i < band.length && picks.filter(p => p.ci === ci).length < PER; i += step) picks.push({ ci, sig: band[i].signature, at: band[i].blockTime });
    });
    // fresh ones come from the quick RPC, older ones from the slow archive: run both lanes at once
    const tP = Date.now();
    const fresh = picks.filter(p => p.ci <= 1), aged = picks.filter(p => p.ci >= 2);
    const [pf, pa] = await Promise.all([mapLimit(fresh, 6, p => migratedMint(p.sig, diag), t0 + 36000), mapLimit(aged, 4, p => migratedMint(p.sig, diag), t0 + 36000)]);
    picks.length = 0; picks.push(...fresh, ...aged);
    const parsed = [...pf, ...pa];
    const tB = Date.now();
    const seen = new Set(), coins = [];
    let parsedOk = 0;
    parsed.forEach((r, i) => { if (r === undefined || r === null) return; parsedOk++; if (!r || seen.has(r.mint)) return; seen.add(r.mint); coins.push({ mint: r.mint, bornAt: r.at || picks[i].at, ci: picks[i].ci }); });
    // 3) heartbeat of each pool
    const beats = await mapLimit(coins, 8, c => lastBeat(canonicalPumpPoolPda(new PublicKey(c.mint))), t0 + 49000);
    const tE = Date.now();
    const meta = await dexMeta(coins.map(c => c.mint));
    const pts = [];
    coins.forEach((c, i) => {
      if (beats[i] === undefined) return; // ran out of time: leave it out rather than guess
      const pool = canonicalPumpPoolPda(new PublicKey(c.mint)).toBase58();
      pts.push({ mint: c.mint, pool, ci: c.ci, ...metaOf(meta, c.mint, pool), ...vitals(c.bornAt, beats[i]) });
    });
    const cohorts = COHORTS.map(([a, b, label], ci) => {
      const band = all.filter(s => now - s.blockTime >= a * 3600 && now - s.blockTime < b * 3600).length;
      const s = pts.filter(p => p.ci === ci);
      return { label, fromH: a, toH: b, migrations: band, sampled: s.length, alive: s.filter(p => p.state === 'alive').length, null: s.filter(p => p.state === 'null').length, covered: a < coveredH };
    });
    const old = pts.filter(p => now - p.bornAt >= TTL);
    const uniqRatio = parsedOk ? coins.length / parsedOk : 1;
    const perDay = all.length && coveredH > 0 ? Math.round(all.length / coveredH * 24 * uniqRatio) : null;
    return {
      updated: Date.now(), took: Date.now() - t0, phases: [tP - t0, tB - tP, tE - tB], pages, notes: diag, coveredHours: Math.round(coveredH), migrationTxs: all.length, perDay,
      sampled: pts.length, oldSampled: old.length, oldNull: old.filter(p => p.state === 'null').length,
      nullRate: old.length ? old.filter(p => p.state === 'null').length / old.length : null,
      cohorts, points: pts,
    };
  });
}

/* ---------------- births: the newest graduations, live ---------------- */
async function births() {
  return cached('births', 40e3, async () => {
    const page = await sigs(MIGRATOR, { limit: 90 });
    const ok = page.filter(s => !s.err && s.blockTime);
    const deadline = Date.now() + 14000;
    const parsed = await mapLimit(ok.slice(0, 45), 6, s => migratedMint(s.signature), deadline);
    const seen = new Set(), coins = [];
    parsed.forEach((r, i) => { if (!r || seen.has(r.mint)) return; seen.add(r.mint); coins.push({ mint: r.mint, bornAt: r.at || ok[i].blockTime, sig: ok[i].signature }); });
    const top = coins.slice(0, 24);
    const beats = await mapLimit(top, 6, c => lastBeat(canonicalPumpPoolPda(new PublicKey(c.mint))), deadline + 6000);
    const meta = await dexMeta(top.map(c => c.mint));
    const list = top.map((c, i) => { const pool = canonicalPumpPoolPda(new PublicKey(c.mint)).toBase58(); return { mint: c.mint, pool, sig: c.sig, ...metaOf(meta, c.mint, pool), ...vitals(c.bornAt, beats[i] || c.bornAt) }; });
    return { updated: Date.now(), births: list };
  });
}

/* ---------------- check: is this coin alive? ---------------- */
async function pumpGlobal() {
  return cached('pumpGlobal', 300e3, async () => { const g = await rpc(c => c.getAccountInfo(PUMP.GLOBAL_PDA)); return g ? PUMP.PUMP_SDK.decodeGlobal(g) : null; });
}
function treasuries(mint) {
  if (!CONFIG.studio) return null;
  const studio = new PublicKey(CONFIG.studio);
  return { studio, coin: mint ? PublicKey.createWithSeed(studio, mint.slice(0, 32), SystemProgram.programId) : null, void: PublicKey.createWithSeed(studio, 'null.void', SystemProgram.programId) };
}
async function check(id) {
  let key = pk(id, 'address');
  const first = await rpc(c => c.getAccountInfo(key));
  if (first && first.owner.equals(PUMP_AMM_PROGRAM_ID)) key = PUMP_AMM_SDK.decodePool(first).baseMint;
  const mint = key, mintS = mint.toBase58();
  const bcKey = PUMP.bondingCurvePda(mint), poolKey = canonicalPumpPoolPda(mint), scKey = PUMP.feeSharingConfigPda(mint);
  const [mi, bci, pi, sci] = await rpc(c => c.getMultipleAccountsInfo([mint, bcKey, poolKey, scKey]));
  if (!mi) throw http(404, 'Nothing lives at that address.');
  const meta = await dexMeta([mintS]);
  const out = { mint: mintS, pool: poolKey.toBase58(), ...metaOf(meta, mintS, poolKey.toBase58()) };
  // launched on null? its fee shares point at the void
  out.onNull = false;
  if (sci) {
    try {
      const sc = PUMP.PUMP_SDK.decodeSharingConfig(sci);
      out.shares = sc.shareholders.map(s => ({ address: s.address.toBase58(), bps: s.shareBps }));
      out.sharesLocked = !!sc.adminRevoked;
      const tr = await treasuries(mintS);
      if (tr) { const v = (await tr.void).toBase58(); out.onNull = out.shares.some(s => s.address === v); }
    } catch (e) { }
  }
  if (bci) {
    const bc = PUMP.PUMP_SDK.decodeBondingCurve(bci);
    if (!bc.complete) {
      const g = await pumpGlobal();
      const init = g ? big(g.initialRealTokenReserves) : 793100000000000n;
      const left = big(bc.realTokenReserves);
      out.stage = 'declared';
      out.progress = init > 0n ? Math.max(0, Math.min(1, Number(init - left) / Number(init))) : null;
      out.curveSol = sol(big(bc.realQuoteReserves));
      out.state = 'declared';
      const s = await sigs(bcKey, { limit: 5 }); const lb = s.find(x => !x.err && x.blockTime);
      out.lastAt = lb ? lb.blockTime : null;
      return out;
    }
  }
  if (!pi || !pi.owner.equals(PUMP_AMM_PROGRAM_ID)) {
    if (bci) { out.stage = 'graduating'; out.state = 'declared'; return out; }
    throw http(404, 'Not a pump.fun coin: no bonding curve and no PumpSwap pool.');
  }
  const pool = PUMP_AMM_SDK.decodePool(pi);
  const accs = await rpc(c => c.getMultipleAccountsInfo([pool.poolQuoteTokenAccount, pool.poolBaseTokenAccount]));
  const Rq = accs[0] ? big(AccountLayout.decode(accs[0].data.slice(0, AccountLayout.span)).amount) : 0n;
  const lastAt = await lastBeat(poolKey);
  out.stage = 'assigned';
  out.poolSol = sol(Rq);
  out.solPool = pool.quoteMint.equals(NATIVE_MINT);
  out.lpSupply = pool.lpSupply.toString();
  Object.assign(out, vitals(out.pairCreatedAt, lastAt));
  return out;
}

/* ---------------- launch: create on pump.fun with the shares locked ---------------- */
const NAME_RE = /^[\x20-\x7E]{1,32}$/, SYM_RE = /^[A-Za-z0-9$]{1,10}$/;
async function buildLaunch(b, origin) {
  if (!CONFIG.studio) throw http(409, 'Launches open the moment the void wallet is set.');
  const user = pk(b.user, 'wallet'), mint = pk(b.mint, 'mint');
  const name = String(b.name || '').trim(), symbol = String(b.symbol || '').trim().replace(/^\$/, '').toUpperCase();
  if (!NAME_RE.test(name)) throw http(400, 'Name: 1–32 plain characters.');
  if (!SYM_RE.test(symbol)) throw http(400, 'Ticker: 1–10 letters or numbers.');
  const devSol = Math.max(0, Math.min(10, Number(b.devSol) || 0));
  const uri = `${origin}/m/${mint.toBase58()}?n=${encodeURIComponent(name)}&s=${encodeURIComponent(symbol)}`;
  if (uri.length > 200) throw http(400, 'Name is too long for the metadata link. Shorten it.');
  const tr = treasuries(mint.toBase58());
  const coinT = await tr.coin, voidT = await tr.void;
  const [ui, ci, vi, mi] = await rpc(c => c.getMultipleAccountsInfo([user, coinT, voidT, mint]));
  if (mi) throw http(409, 'That mint already exists. Refresh to get a new one.');
  const RENT0 = 890880n;
  const pre = [];
  if (!ci) pre.push(SystemProgram.transfer({ fromPubkey: user, toPubkey: coinT, lamports: RENT0 }));
  // the void is touched by every launch (0 SOL after the first), so its own history lists every coin born on null
  pre.push(SystemProgram.transfer({ fromPubkey: user, toPubkey: voidT, lamports: vi ? 0n : RENT0 }));
  const need = 30_000_000n + BigInt(Math.floor(devSol * 1e9));
  if (!ui || BigInt(ui.lamports) < need) throw http(400, `Not enough SOL. A launch needs about ${sol(need).toFixed(3)} SOL (rent, fees${devSol ? ' and the dev buy' : ''}).`);
  const create = await PUMP.PUMP_SDK.createV2Instruction({ mint, name, symbol, uri, creator: user, user, mayhemMode: false });
  const fsc = await PUMP.PUMP_SDK.createFeeSharingConfig({ creator: user, mint, pool: null });
  const shares = [{ address: user, shareBps: CONFIG.creatorBps }, { address: coinT, shareBps: CONFIG.poolBps }, { address: voidT, shareBps: CONFIG.voidBps }];
  const upd = await PUMP.PUMP_SDK.updateFeeSharesV2({ authority: user, mint, currentShareholders: [user], newShareholders: shares, quoteMint: NATIVE_MINT, quoteTokenProgram: TOKEN_PROGRAM_ID });
  const groups = [[create, fsc], [...pre, upd]];
  let buyQuote = null;
  if (devSol > 0) {
    const g = await pumpGlobal();
    const fcInfo = await rpc(c => c.getAccountInfo(PUMP.PUMP_FEE_CONFIG_PDA));
    const feeConfig = fcInfo ? PUMP.PUMP_SDK.decodeFeeConfig(fcInfo) : null;
    const bc = PUMP.newBondingCurve(g); bc.creator = PUMP.feeSharingConfigPda(mint);
    const lam = new BN(Math.floor(devSol * 1e9).toString());
    const amount = PUMP.getBuyTokenAmountFromSolAmount({ global: g, feeConfig, mintSupply: g.tokenTotalSupply, bondingCurve: bc, amount: lam });
    const buy = await PUMP.PUMP_SDK.buyInstructions({ global: g, bondingCurveAccountInfo: null, bondingCurve: bc, associatedUserAccountInfo: null, mint, user, amount, solAmount: lam, slippage: 2, tokenProgram: TOKEN_2022_PROGRAM_ID });
    groups.push(buy);
    buyQuote = { sol: devSol, tokens: amount.toString() };
  }
  // compile all, simulate the first (the mint signature is added in the browser)
  const { blockhash, lastValidBlockHeight } = await rpc(c => c.getLatestBlockhash('confirmed'));
  const price = await priorityFee([]);
  const txs = [];
  for (let i = 0; i < groups.length; i++) {
    const units = i === 0 ? 350000 : 250000;
    const all = [ComputeBudgetProgram.setComputeUnitLimit({ units }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price }), ...groups[i]];
    const msg = new TransactionMessage({ payerKey: user, recentBlockhash: blockhash, instructions: all }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    const bytes = tx.serialize();
    if (bytes.length > 1232) throw http(500, 'Launch transaction too large; shorten the name.');
    if (i === 0) {
      const r = await rpc(c => c.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'processed' }));
      if (r.value.err) { const e = http(400, 'pump.fun would reject this launch: ' + JSON.stringify(r.value.err).slice(0, 120)); e.logs = (r.value.logs || []).slice(-10); throw e; }
    }
    txs.push({ tx: Buffer.from(bytes).toString('base64'), bytes: bytes.length });
  }
  return { txs, blockhash, lastValidBlockHeight, mint: mint.toBase58(), uri, buy: buyQuote, shares: shares.map(s => ({ address: s.address.toBase58(), bps: s.shareBps })), treasury: { coin: coinT.toBase58(), void: voidT.toBase58() } };
}

/* ---------------- the void + every coin launched on null ---------------- */
async function theVoid() {
  return cached('void', 60e3, async () => {
    const out = { studio: CONFIG.studio || null, ca: CONFIG.ca || null, launches: [], void: null, nullToken: null };
    if (CONFIG.ca) {
      try {
        const supply = await rpc(c => c.getTokenSupply(new PublicKey(CONFIG.ca)));
        const s = Number(supply.value.uiAmount);
        out.nullToken = { supply: s, burned: Math.max(0, 1e9 - s) };
      } catch (e) { }
    }
    if (!CONFIG.studio) return out;
    const tr = treasuries(null); const voidT = await tr.void;
    out.void = { address: voidT.toBase58(), sol: sol(BigInt(await rpc(c => c.getBalance(voidT)))) };
    // every launch adds the void as a shareholder, so the void's history lists every coin born here
    const s = await sigs(voidT, { limit: 200 });
    const ok = s.filter(x => !x.err);
    const found = await mapLimit(ok.slice(0, 60), 5, async x => {
      const t = await rpc(c => c.getParsedTransaction(x.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }));
      if (!t) return null;
      const ix = t.transaction.message.instructions.find(i => i.programId && i.programId.equals(PUMP.PUMP_FEE_PROGRAM_ID) && i.accounts && i.accounts.length > 6);
      return ix ? { mint: ix.accounts[4].toBase58(), at: t.blockTime } : null;
    }, Date.now() + 15000);
    const seen = new Set(), coins = [];
    found.forEach(f => { if (f && !seen.has(f.mint)) { seen.add(f.mint); coins.push(f); } });
    const meta = await dexMeta(coins.map(c => c.mint));
    const states = await mapLimit(coins, 5, async c => {
      const pool = canonicalPumpPoolPda(new PublicKey(c.mint));
      const [pi] = await rpc(x => x.getMultipleAccountsInfo([pool]));
      if (!pi) return { state: 'declared' };
      return vitals(null, await lastBeat(pool));
    });
    out.launches = coins.map((c, i) => ({ mint: c.mint, launchedAt: c.at, ...metaOf(meta, c.mint), ...(states[i] || {}) }));
    return out;
  });
}

/* ---------------- metadata + a generated image for every coin born on null ---------------- */
function crc32(buf) { let c, crc = 0xffffffff; for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; }
function png(w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3); }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
// a sigil from the mint: a mirrored 11x11 glyph inside an empty ring, off-white on black
function sigil(mintS) {
  const h = crypto.createHash('sha256').update('null:' + mintS).digest();
  const N = 512, G = 11, cell = 18, ox = (N - G * cell) / 2, oy = ox;
  const img = Buffer.alloc(N * N * 3);
  for (let i = 0; i < N * N; i++) { const n = (h[i % 32] ^ (i * 2654435761 >>> 24)) & 7; img[i * 3] = img[i * 3 + 1] = img[i * 3 + 2] = 7 + n; }
  const ink = [232, 230, 225], dim = [70, 70, 72];
  const set = (x, y, c) => { if (x < 0 || y < 0 || x >= N || y >= N) return; const o = (y * N + x) * 3; img[o] = c[0]; img[o + 1] = c[1]; img[o + 2] = c[2]; };
  // ring
  const cx = N / 2, cy = N / 2, R = 200;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { const d = Math.hypot(x - cx, y - cy); if (d > R - 7 && d < R + 7) set(x, y, d > R - 3 && d < R + 3 ? ink : dim); }
  // glyph
  let bit = 0; const cells = [];
  for (let y = 0; y < G; y++) for (let x = 0; x <= G >> 1; x++) { const on = (h[(bit >> 3) % 32] >> (bit & 7)) & 1; bit++; if (on && Math.hypot(x - 5, y - 5) < 5.6) { cells.push([x, y]); cells.push([G - 1 - x, y]); } }
  for (const [gx, gy] of cells) for (let yy = 2; yy < cell - 2; yy++) for (let xx = 2; xx < cell - 2; xx++) set(ox + gx * cell + xx, oy + gy * cell + yy, ink);
  return png(N, N, img);
}
function metaJson(mintS, q, origin) {
  const name = String(q.get('n') || 'null').slice(0, 32), symbol = String(q.get('s') || 'NULL').slice(0, 10);
  return {
    name, symbol,
    description: `Born on null. Alive while it trades on PumpSwap; 72 hours of silence and it returns null. ${origin.replace(/^https?:\/\//, '')}`,
    image: `${origin}/i/${mintS}.png`, showName: true, createdOn: origin, website: `${origin}/?c=${mintS}`,
  };
}

/* ---------------- router ---------------- */
module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  const url = new URL(req.url, 'http://x');
  const q = url.searchParams;
  const path = (q.get('__p') || url.pathname.replace(/^\/api\/?/, '')).replace(/\/+$/, '');
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  const origin = (/^localhost|^127\./.test(host) ? 'http://' : 'https://') + host;
  try {
    if (path === 'config') return send(res, 200, { ok: true, launch: !!CONFIG.studio, studio: CONFIG.studio || null, ca: CONFIG.ca, x: CONFIG.x, ttlHours: TTL / 3600, shares: { creator: CONFIG.creatorBps, pool: CONFIG.poolBps, void: CONFIG.voidBps }, hostFeeBps: CONFIG.jug ? CONFIG.feeBps : 0, rpc: E('RPC_URL') ? 'private' : 'public' }, 'public, s-maxage=60');
    if (path === 'census') return send(res, 200, { ok: true, ...(await census()) }, 'public, s-maxage=600, stale-while-revalidate=3600');
    if (path === 'births') return send(res, 200, { ok: true, ...(await births()) }, 'public, s-maxage=30, stale-while-revalidate=120');
    if (path === 'check') return send(res, 200, { ok: true, coin: await check(String(q.get('id') || '').trim()) }, 'public, s-maxage=15');
    if (path === 'void') return send(res, 200, { ok: true, ...(await theVoid()) }, 'public, s-maxage=30, stale-while-revalidate=120');
    if (path === 'meta') {
      const m = String(q.get('mint') || ''); if (!B58.test(m)) throw http(400, 'bad mint');
      return send(res, 200, metaJson(m, q, origin), 'public, max-age=300, s-maxage=86400');
    }
    if (path === 'img') {
      const m = String(q.get('mint') || '').replace(/\.png$/, ''); if (!B58.test(m)) throw http(400, 'bad mint');
      res.setHeader('Content-Type', 'image/png'); res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=31536000, immutable'); res.setHeader('Access-Control-Allow-Origin', '*');
      return res.status(200).send(sigil(m));
    }
    if (path === 'pools') return send(res, 200, { ok: true, ...(await pools()) }, 'public, s-maxage=60, stale-while-revalidate=240');
    if (path === 'pool') return send(res, 200, { ok: true, pool: await poolOne(q.get('id'), q.get('user')) }, q.get('user') ? 'no-store' : 'public, s-maxage=10');
    if (path === 'positions') return send(res, 200, { ok: true, ...(await positions(q.get('user'))) });
    if (path === 'status') {
      const sig = String(q.get('sig') || '');
      if (!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(sig)) throw http(400, 'bad signature');
      const r = await rpc(c => c.getSignatureStatuses([sig], { searchTransactionHistory: false }));
      const s = r.value[0];
      return send(res, 200, { ok: true, status: s ? s.confirmationStatus : null, err: s ? s.err : null });
    }
    if (path === 'blockhash') { const b = await rpc(c => c.getLatestBlockhash('confirmed')); return send(res, 200, { ok: true, ...b }); }
    if (path === 'slot') { const s = await cached('slot', 4000, () => rpc(c => c.getSlot('confirmed'))); return send(res, 200, { ok: true, slot: s }, 'public, s-maxage=4'); }
    if (req.method !== 'POST') throw http(404, 'Not found');
    const b = await readBody(req);
    if (path === 'tx') {
      const kind = String(b.kind || '');
      const r = kind === 'add' ? await buildAdd(b) : kind === 'add2' ? await buildAdd2(b) : kind === 'remove' ? await buildRemove(b) : null;
      if (!r) throw http(400, 'unknown kind');
      return send(res, 200, { ok: true, ...r });
    }
    if (path === 'launch') return send(res, 200, { ok: true, ...(await buildLaunch(b, origin)) });
    if (path === 'send') {
      const raw = Buffer.from(String(b.tx || ''), 'base64');
      if (raw.length < 100 || raw.length > 1232) throw http(400, 'bad transaction');
      const sig = await rpc(c => c.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: 'processed', maxRetries: 3 }));
      return send(res, 200, { ok: true, sig });
    }
    throw http(404, 'Not found');
  } catch (e) {
    const code = e.code && e.code >= 400 && e.code < 600 ? e.code : 500;
    return send(res, code, { ok: false, error: String(e.message || e).slice(0, 400), logs: e.logs || undefined });
  }
};
module.exports._t = { planAdd, buyCost, keep, cow, sigil, vitals, metaJson, png };
