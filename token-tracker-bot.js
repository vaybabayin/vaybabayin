require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const { ethers } = require('ethers');
const axios = require('axios');

const VERSION = 'v11.9';
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
// One or more chat IDs, comma-separated. Chats listed here survive redeploys
// without anyone having to send /start again.
const CHANNEL_IDS   = (process.env.TELEGRAM_CHANNEL_ID || '').split(',').map(s => s.trim()).filter(Boolean);
const CONTRACT      = process.env.TOKEN_CONTRACT || '0xAe5F595803B2AA4D07aF8b392e535876a974a296';
const SC1_TARGET    = parseInt(process.env.SC1_TARGET || '200');
const SC2_TARGET    = parseInt(process.env.SC2_TARGET || '200');
const SC3_TARGET    = parseInt(process.env.SC3_TARGET || '250');
const COINGECKO_KEY = process.env.COINGECKO_API_KEY || '';
const ALCHEMY_KEY   = process.env.ALCHEMY_API_KEY   || 'GJQAkDF-FLHo6I32OqUeh';
const ALCHEMY_HTTP  = `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`;
const ALCHEMY_WSS   = `wss://base-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`;

if (!TELEGRAM_TOKEN) { console.error('TELEGRAM_BOT_TOKEN eksik!'); process.exit(1); }

const CONTRACT_LOWER = CONTRACT.toLowerCase();
const ZERO_ADDRESS   = '0x0000000000000000000000000000000000000000';
const USDC_LOWER     = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

const BOT_START_TS    = Math.floor(Date.now() / 1000);
const LIVE_WINDOW_SEC = 300;

const registeredChats = new Set(CHANNEL_IDS);

// Chats and the NFT→tier map used to live only in memory, so every Railway
// redeploy wiped them: notifications were silently discarded until someone
// sent /start again, and cards bought before the deploy lost their tier.
// Both are persisted to disk — across restarts always, and across redeploys
// when a Railway volume is mounted (RAILWAY_VOLUME_MOUNT_PATH / DATA_DIR).
const DATA_DIR      = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
const STATE_FILE    = path.join(DATA_DIR, 'bot-state.json');
const NFT_STATE_MAX = 20000;
let savedStateSig   = '';

const RPCS = [
  ALCHEMY_HTTP,
  'https://mainnet.base.org',
  'https://base-rpc.publicnode.com',
  process.env.RPC_URL_1,
  process.env.RPC_URL_2,
  'https://base.gateway.tenderly.co',
  'https://1rpc.io/base',
].filter(Boolean);

// v10.0: 3 tiers, all $1 USDC. Tier encoded in coordinator BUY event topics.
// v11.5: jackpot detection uses a fixed Total-Value band per tier:
//   mavi  $4–8   ·  yeşil $7–15  ·  mor $15–30  (inclusive).
// Any claim whose Total Value falls in the band counts as a jackpot.
// jackpotTotal: expected jackpots per cycle.
const TIER_INFO = {
  1: { name: 'mavi',  emoji: '🔵', payUsd: 1, target: SC1_TARGET, jackpotMin: 4,  jackpotMax: 8,  jackpotTotal: 6 },
  2: { name: 'yeşil', emoji: '🟢', payUsd: 1, target: SC2_TARGET, jackpotMin: 7,  jackpotMax: 15, jackpotTotal: 4 },
  3: { name: 'mor',   emoji: '🟣', payUsd: 1, target: SC3_TARGET, jackpotMin: 15, jackpotMax: 30, jackpotTotal: 3 },
};
const PER_TOKEN_MAX_USD = 100;
// v10.5: only notify for packages bought with ~1 USDC. Free packages
// (paid = 0) have a tier in calldata but no USDC payment — skip them.
const MIN_PAID_USDC = 0.5;

// v11.4/v11.6: a normal prize token for a tier is worth roughly its $1 share.
// Anything far above the tier's max jackpot is SUSPICIOUS — either a genuine
// jackpot prize or a bad (dust/scam-pool) aggregator price. This threshold is
// the trigger to double-check a token against on-chain reserves before trusting
// it; it is NOT a hard drop (see calcTotalUsd).
function perTokenCapUsd(tier) {
  const t = tier && TIER_INFO[tier] ? TIER_INFO[tier] : null;
  return t ? t.jackpotMax : 30; // mavi $8 · yeşil $15 · mor $30 · unknown $30
}

// ── Series (batch) tracking, read from chain ──────────────────────────────
// The NFT contract stores every card's series: cards(id) → (batchId, tier,
// mintedAt, outcome). Cards of a tier are sold series by series, so counting
// minted cards per (tier, batchId) gives how many of the current series are
// sold, and the total of the last finished series gives the series size —
// no manual input needed. SC*_TARGET are only used until a size is learned.
const NFT_ABI = [
  'function cards(uint256) view returns (uint64 batchId, uint8 tier, uint64 mintedAt, bytes outcome)',
];
function newSeries() {
  return { current: null, sold: new Map(), complete: new Set(), size: null, jackpots: new Map() };
}
const series = { 1: newSeries(), 2: newSeries(), 3: newSeries() };
const countedMints = new Set();
const seriesScan = { status: 'başlamadı', done: false };
let stateRev = 0; // bumped on series changes that must be persisted

// A card's tier and series. Pass the block before a burn to read a card that
// has since been claimed (claimed cards read as empty at the latest block).
async function readCard(nftId, blockTag) {
  if (!_nftContractAddr) return null;
  const c = new ethers.Contract(_nftContractAddr, NFT_ABI, provider);
  for (const tag of blockTag !== undefined ? [blockTag, 'latest'] : ['latest']) {
    try {
      const r = await c.cards(BigInt(nftId), { blockTag: tag });
      const tier = Number(r.tier), batchId = Number(r.batchId);
      if (tier >= 1 && tier <= 3 && r.mintedAt > 0n) return { tier, batchId };
    } catch (_) {}
  }
  return null;
}

// Counts one minted card. `live` mints extend the chain head; history-scan
// mints arrive newest-first and never move the current series forward.
function addSold(tier, batchId, nftId, live) {
  if (countedMints.has(nftId)) return;
  countedMints.add(nftId);
  const s = series[tier];
  s.sold.set(batchId, (s.sold.get(batchId) || 0) + 1);
  if (s.current === null || batchId > s.current) {
    // A new series started: the one it replaces is finished, and if it was
    // counted from its first card its total is the series size.
    if (live && s.current !== null && s.complete.has(s.current)) s.size = s.sold.get(s.current);
    if (live && s.current !== null) s.complete.add(batchId);
    s.current = batchId;
  }
}

// Scans mints newest → oldest until, for every tier, the scan has passed
// the start of the previous series (3 distinct series seen). Then the current
// series is fully counted and the previous one gives the series size.
async function scanSeriesHistory() {
  if (!_nftContractAddr) return;
  seriesScan.status = 'taranıyor';
  const MAX_LOOKBACK = 600_000; // ~2 weeks of Base blocks
  const fromZero = '0x' + '0'.repeat(64);
  const seen = { 1: new Set(), 2: new Set(), 3: new Set() };
  const done = () => [1, 2, 3].every(t => seen[t].size >= 3);
  const head = await provider.getBlockNumber();
  let to = head, cards = 0, failures = 0;
  while (to > 0 && head - to < MAX_LOOKBACK && !done()) {
    const from = Math.max(0, to - logsSpan + 1);
    let logs;
    try {
      logs = await provider.getLogs({ address: _nftContractAddr, topics: [TRANSFER_TOPIC, fromZero], fromBlock: from, toBlock: to });
      failures = 0;
    } catch (e) {
      if (logsSpan > 10) { logsSpan = Math.max(10, Math.floor(logsSpan / 2)); continue; }
      if (++failures >= 20) throw new Error(`getLogs art arda başarısız: ${e.message}`);
      await sleep(2000);
      continue;
    }
    logs.sort((a, b) => b.blockNumber - a.blockNumber || (b.index ?? 0) - (a.index ?? 0));
    for (const l of logs) {
      if (l.topics.length !== 4) continue;
      const id = BigInt(l.topics[3]).toString();
      if (countedMints.has(id)) continue;
      const card = await readCard(id, l.blockNumber);
      if (!card) continue;
      addSold(card.tier, card.batchId, id, false);
      seen[card.tier].add(card.batchId);
      cards++;
    }
    to = from - 1;
    seriesScan.status = `taranıyor (${cards} kart, ${head - to} blok geri)`;
  }
  for (const t of [1, 2, 3]) {
    const s = series[t];
    const ids = [...seen[t]].sort((a, b) => b - a);
    // Every series newer than the oldest one seen was counted from its start.
    for (const b of ids.slice(0, -1)) s.complete.add(b);
    if (ids.length >= 3) s.size = s.sold.get(ids[1]);
  }
  seriesScan.done = true;
  seriesScan.status = `bitti (${cards} kart)`;
  console.log(`[SERİ] ${[1, 2, 3].map(t => `${TIER_INFO[t].name}: ${seriesLine(t)}`).join(' | ')}`);
}

// "153/200 satıldı · 47 kaldı" for the tier's current series.
function seriesStatus(tier) {
  const s = series[tier];
  if (s.current === null) return null;
  const sold    = s.sold.get(s.current) || 0;
  const exact   = s.complete.has(s.current);
  const size    = s.size ?? TIER_INFO[tier].target;
  const left    = Math.max(0, size - sold);
  return { batchId: s.current, sold, size, left, exact, sizeKnown: s.size !== null };
}

function seriesLine(tier) {
  const st = seriesStatus(tier);
  if (!st) return seriesScan.done ? 'seri bilinmiyor' : 'seri sayılıyor…';
  const soldTxt = st.exact ? `${st.sold}` : `≥${st.sold}`;
  const sizeTxt = st.sizeKnown ? `${st.size}` : `${st.size}?`;
  return `seri #${st.batchId}: ${soldTxt}/${sizeTxt} satıldı · ${st.exact ? '' : '≤'}${st.left} kaldı`;
}

const TRANSFER_TOPIC     = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
// Coordinator event sig prefixes (first 8 bytes of topic[0])
const BUY_EVENT_PREFIX   = '0x22e804d3';
const CLAIM_EVENT_PREFIX = '0xd7fd12e8';
// NFT contract custom event seen in logs (0x73c1e6085df115c7...)
const NFT_CUSTOM_PREFIX  = '0x73c1e608';
// ERC-4337 v0.6 EntryPoint handleOps selector
const EP_HANDLEOPS_SEL   = '0x1fad948c';

// ethers.Interface instance for decoding handleOps (lazy-initialised)
let _epIface = null;
function getEpIface() {
  if (!_epIface) _epIface = new ethers.Interface([
    'function handleOps((address sender,uint256 nonce,bytes initCode,bytes callData,uint256 callGasLimit,uint256 verificationGasLimit,uint256 preVerificationGas,uint256 maxFeePerGas,uint256 maxPriorityFeePerGas,bytes paymasterAndData,bytes signature)[] ops,address beneficiary)',
  ]);
  return _epIface;
}

const CHAINLINK_ETHUSD = '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70';
const WETH             = '0x4200000000000000000000000000000000000006';
const USDC             = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const UNI_FACTORY      = '0x33128a8fC17869897dcE68Ed026d694621f6FDfD';
const AERO_FACTORY     = '0x420DD381b31aEf6683db6B902084cB0FFECe40Da';
const WETH_LOWER       = WETH.toLowerCase();

const tierStates = {};
function ts(tier) {
  if (!tierStates[tier])
    tierStates[tier] = { history: [], count: 0, streak: 0, streakDir: null };
  return tierStates[tier];
}

const nftToTier = new Map();
let processedTxs = new Set();
let pollingErrCount = 0;
let provider, bot;
let tokenInfoCache = {};
let priceCache = {};
let ethPrice = 0, ethPriceAt = 0;
let lastPollBlock = 0;
let isLoadingHistory = false;
let _recentTiersPromise = null;
// Known scratch-card NFT contract, so the WebSocket subscription and the tier
// warm-up scan work from the first second instead of waiting to auto-detect it.
let _nftContractAddr = (process.env.NFT_CONTRACT || '0x154dacdec3459e551fc426f82e78e518a1f8f984').toLowerCase();
let rpcIndex = 0;
let primaryRetryTimer = null;

// Notifications produced while no chat is registered are kept and delivered
// to the first chat that registers instead of being thrown away.
const undelivered     = [];
const UNDELIVERED_MAX = 50;

// Claims that hit a transient failure (receipt not indexed yet, price APIs
// down, tier lookup failed) are retried instead of being dropped for good.
const retryQueue = new Map(); // txHash → { tries, due }
const RETRY_MAX  = 4;
const inFlight   = new Set();

const stats = { claims: 0, notified: 0, skipNoTier: 0, skipFree: 0, skipNoValue: 0, retries: 0, lastBlock: 0 };

// WebSocket subscription state
let wsProvider       = null;
let wsConnected      = false;
let wsReconnectTimer = null;

const sleep   = (ms) => new Promise(r => setTimeout(r, ms));
const rpcHost = (u) => { try { return new URL(u).host; } catch (_) { return '?'; } };

// Tries RPCs starting at `startAt`, so a failing endpoint is rotated away from
// instead of being picked again just because it is first in the list.
async function getProvider(startAt = 0) {
  for (let i = 0; i < RPCS.length; i++) {
    const idx = (startAt + i) % RPCS.length;
    try {
      const p = new ethers.JsonRpcProvider(RPCS[idx]);
      await Promise.race([p.getBlockNumber(),
        new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 5000))]);
      console.log(`[RPC ✓] ${rpcHost(RPCS[idx])}`);
      rpcIndex = idx;
      return p;
    } catch (e) { console.log(`[RPC ✗] ${rpcHost(RPCS[idx])} ${e.message.slice(0, 70)}`); }
  }
  throw new Error('Hiçbir RPC bağlanamadı');
}

async function switchProvider() {
  try { provider = await getProvider(rpcIndex + 1); } catch (_) { return; }
  // Fell back off the primary (Alchemy): try to return to it in 10 minutes.
  if (rpcIndex !== 0 && !primaryRetryTimer) {
    primaryRetryTimer = setTimeout(async () => {
      primaryRetryTimer = null;
      try { provider = await getProvider(0); } catch (_) {}
    }, 10 * 60_000);
  }
}

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    for (const id of s.chats || []) registeredChats.add(String(id));
    for (const [id, e] of s.nftToTier || []) if (!nftToTier.has(id)) nftToTier.set(id, e);
    // Jackpots seen per series (claim values can't be re-derived from chain).
    for (const t of [1, 2, 3]) for (const [b, n] of s.jackpots?.[t] || []) series[t].jackpots.set(b, n);
    console.log(`[STATE] yüklendi: chat=${(s.chats || []).length} nft=${(s.nftToTier || []).length} (${STATE_FILE})`);
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[STATE] okunamadı:', e.message);
  }
  savedStateSig = `${registeredChats.size}:${nftToTier.size}:${stateRev}`;
}

function saveState(force = false) {
  const sig = `${registeredChats.size}:${nftToTier.size}:${stateRev}`;
  if (!force && sig === savedStateSig) return;
  try {
    const nft = [...nftToTier.entries()].slice(-NFT_STATE_MAX);
    const jackpots = Object.fromEntries([1, 2, 3].map(t => [t, [...series[t].jackpots.entries()].slice(-20)]));
    fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify({ chats: [...registeredChats], nftToTier: nft, jackpots }));
    fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
    savedStateSig = sig;
  } catch (e) { console.error('[STATE] yazılamadı:', e.message); }
}

async function getEthUsd() {
  if (Date.now() - ethPriceAt < 60_000 && ethPrice > 0) return ethPrice;
  try {
    const cl = new ethers.Contract(CHAINLINK_ETHUSD,
      ['function latestAnswer() view returns (int256)'], provider);
    ethPrice = Number(await cl.latestAnswer()) / 1e8;
    ethPriceAt = Date.now();
  } catch (_) { if (!ethPrice) ethPrice = 3000; }
  return ethPrice;
}

async function getTokenInfo(address) {
  const k = address.toLowerCase();
  if (tokenInfoCache[k]) return tokenInfoCache[k];
  let symbol = '???', decimals = 18;
  try {
    const r = await axios.get(`https://base.blockscout.com/api/v2/tokens/${address}`, { timeout: 6000 });
    if (r.data?.symbol) {
      symbol = r.data.symbol; decimals = parseInt(r.data.decimals ?? 18);
      tokenInfoCache[k] = { symbol, decimals }; return tokenInfoCache[k];
    }
  } catch (_) {}
  const c = new ethers.Contract(address,
    ['function symbol() view returns (string)', 'function decimals() view returns (uint8)'], provider);
  try { symbol   = await c.symbol(); } catch (_) {}
  try { decimals = Number(await c.decimals()); } catch (_) {}
  tokenInfoCache[k] = { symbol, decimals };
  return tokenInfoCache[k];
}

async function cgPrice(address) {
  const isPro = COINGECKO_KEY && COINGECKO_KEY.startsWith('CG-');
  const host  = isPro ? 'https://pro-api.coingecko.com' : 'https://api.coingecko.com';
  const url   = `${host}/api/v3/simple/token_price/base`;
  const params = { contract_addresses: address, vs_currencies: 'usd' };
  const headers = {};
  if (COINGECKO_KEY) {
    if (isPro) headers['x-cg-pro-api-key'] = COINGECKO_KEY;
    else       headers['x-cg-demo-api-key'] = COINGECKO_KEY;
  }
  const fetchOnce = async () => {
    try {
      const r = await axios.get(url, { params, headers, timeout: 6000 });
      const obj = r.data?.[address.toLowerCase()];
      const p = obj?.usd;
      return typeof p === 'number' && p > 0 && p < 1e9 ? p : null;
    } catch (_) { return null; }
  };
  const first = await fetchOnce();
  if (first) return first;
  await new Promise(r => setTimeout(r, 1500));
  return await fetchOnce();
}

async function dsPrice(address) {
  try {
    const r = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${address}`, { timeout: 8000 });
    const pairs = (r.data?.pairs || [])
      .filter(p => p.chainId === 'base')
      .filter(p => p.priceUsd && parseFloat(p.priceUsd) > 0)
      .map(p => ({ price: parseFloat(p.priceUsd), liq: Number(p.liquidity?.usd) || 0 }))
      .sort((a, b) => b.liq - a.liq);
    if (!pairs.length) return null;
    // v11.4: prefer pools with real liquidity. A dust/scam pool can report a
    // wildly wrong priceUsd (e.g. a token 40x too high), which poisons the
    // total. Use the deepest pool over $1k; fall back to the deepest overall
    // only if none clear the bar (so a legit thin token isn't lost).
    const DUST_LIQ_USD = 1000;
    const deep = pairs.filter(p => p.liq >= DUST_LIQ_USD);
    return (deep.length ? deep[0] : pairs[0]).price;
  } catch (_) { return null; }
}

// On-chain price only (Uniswap v3 → Aerodrome), bypassing DEX aggregators.
// Pool reserves/slot0 are on-chain truth and can't be spoofed by a scam pool,
// so this is used to re-price a token whose aggregator value looks implausible.
async function onchainPriceUsd(address, decimals) {
  if (decimals == null) {
    try { decimals = (await getTokenInfo(address)).decimals; } catch (_) { decimals = 18; }
  }
  let p = await uniPrice(address, decimals);
  if (!p) p = await aeroPrice(address, decimals);
  return p || null;
}

async function uniPrice(address, decimals) {
  const k = address.toLowerCase();
  const uniFactory = new ethers.Contract(UNI_FACTORY,
    ['function getPool(address,address,uint24) view returns (address)'], provider);
  let best = { price: 0, liq: 0n };
  for (const [quote, qDec, isEth] of [[USDC, 6, false], [WETH, 18, true]]) {
    for (const fee of [100, 500, 3000, 10000]) {
      try {
        const pa = await uniFactory.getPool(address, quote, fee);
        if (!pa || pa === ethers.ZeroAddress) continue;
        const pool = new ethers.Contract(pa, [
          'function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)',
          'function token0() view returns (address)',
          'function liquidity() view returns (uint128)',
        ], provider);
        const [s, t0, liq] = await Promise.all([pool.slot0(), pool.token0(), pool.liquidity()]);
        const isT0 = t0.toLowerCase() === k;
        const sq = Number(s[0]) / 2 ** 96, pr = sq * sq;
        const piq = isT0 ? pr*(10**qDec)/(10**decimals) : (1/pr)*(10**decimals)/(10**qDec);
        const pusd = isEth ? piq * await getEthUsd() : piq;
        if (!(pusd > 0 && pusd < 1e9)) continue;
        if (BigInt(liq) > best.liq) best = { price: pusd, liq: BigInt(liq) };
      } catch (_) {}
    }
  }
  return best.price > 0 ? best.price : null;
}

async function aeroPrice(address, decimals) {
  const k = address.toLowerCase();
  try {
    const af = new ethers.Contract(AERO_FACTORY,
      ['function getPair(address,address,bool) view returns (address)'], provider);
    let best = { price: 0, depth: 0 };
    for (const [quote, qDec, isEth] of [[USDC, 6, false], [WETH, 18, true]]) {
      for (const stable of [false, true]) {
        try {
          const pa = await af.getPair(address, quote, stable);
          if (!pa || pa === ethers.ZeroAddress) continue;
          const pair = new ethers.Contract(pa, [
            'function getReserves() view returns (uint112,uint112,uint32)',
            'function token0() view returns (address)',
          ], provider);
          const [res, t0] = await Promise.all([pair.getReserves(), pair.token0()]);
          const isT0 = t0.toLowerCase() === k;
          const tokR = Number(ethers.formatUnits(isT0 ? res[0] : res[1], decimals));
          const quoR = Number(ethers.formatUnits(isT0 ? res[1] : res[0], qDec));
          if (tokR <= 0 || quoR <= 0) continue;
          const pusd  = isEth ? (quoR/tokR)*await getEthUsd() : quoR/tokR;
          const depth = isEth ? quoR * await getEthUsd() : quoR;
          if (!(pusd > 0 && pusd < 1e9)) continue;
          if (depth > best.depth) best = { price: pusd, depth };
        } catch (_) {}
      }
    }
    return best.price > 0 ? best.price : null;
  } catch (_) { return null; }
}

async function getTokenPriceUsd(address) {
  const k = address.toLowerCase();
  const cached = priceCache[k];
  if (cached && Date.now() - cached.at < 60_000) return cached.price;
  if (k === WETH_LOWER) {
    const eth = await getEthUsd();
    if (eth) { priceCache[k] = { price: eth, at: Date.now(), src: 'chainlink' }; return eth; }
  }
  const { decimals } = await getTokenInfo(address);
  let price = null, src = null;
  price = await cgPrice(address);                           if (price) src = 'cg';
  if (!price) { price = await dsPrice(address);             if (price) src = 'ds'; }
  if (!price) { price = await uniPrice(address, decimals);  if (price) src = 'uni'; }
  if (!price) { price = await aeroPrice(address, decimals); if (price) src = 'aero'; }
  if (price) { priceCache[k] = { price, at: Date.now(), src }; return price; }
  return null;
}

function calcAvg(arr, n) {
  if (arr.length < n) return null;
  return arr.slice(0, n).reduce((s, v) => s + v.usd, 0) / n;
}

function overallAvg(tierNum) {
  const h = (tierStates[tierNum] || {}).history || [];
  if (!h.length) return null;
  return h.reduce((s, c) => s + c.usd, 0) / h.length;
}

// Sends one message, retrying once on transient errors (network blips,
// Telegram rate limits). Chats that blocked/removed the bot are unregistered.
async function deliver(chatId, msg) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await bot.sendMessage(chatId, msg, { parse_mode: 'HTML', disable_web_page_preview: true });
      return true;
    } catch (e) {
      const m = e.message || '';
      console.error(`[TG HATA] chat=${chatId} deneme=${attempt} | ${m}`);
      if (m.includes('bot was blocked') || m.includes('chat not found') || m.includes('kicked')) {
        registeredChats.delete(chatId);
        saveState(true);
        return false;
      }
      if (attempt === 1) await sleep(2000);
    }
  }
  return false;
}

async function sendNotification(msg) {
  if (registeredChats.size === 0) {
    undelivered.push(msg);
    if (undelivered.length > UNDELIVERED_MAX) undelivered.shift();
    console.log(`[NOTIFY] kayıtlı chat yok — bildirim kuyruğa alındı (${undelivered.length}). /start gönderin veya TELEGRAM_CHANNEL_ID ayarlayın.`);
    return;
  }
  let ok = false;
  for (const chatId of [...registeredChats]) ok = (await deliver(chatId, msg)) || ok;
  if (ok) stats.notified++;
}

// Registers a chat for notifications, persists it, and hands it any
// notifications that were queued while no chat was registered.
async function registerChat(chatId) {
  const id = String(chatId);
  if (registeredChats.has(id)) return false;
  registeredChats.add(id);
  saveState(true);
  console.log(`[TG] Chat kaydedildi: ${id} (toplam: ${registeredChats.size})`);
  if (undelivered.length) {
    const queued = undelivered.splice(0);
    await bot.sendMessage(id, `📦 Chat kayıtlı değilken gelen ${queued.length} bildirim:`).catch(() => {});
    for (const msg of queued) await deliver(id, msg);
    stats.notified += queued.length;
  }
  return true;
}

function rememberNftContract(receipt) {
  if (_nftContractAddr) return;
  for (const log of receipt.logs) {
    if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
    if (log.topics.length !== 4) continue;
    const f = ('0x' + log.topics[1].slice(26)).toLowerCase();
    const t = ('0x' + log.topics[2].slice(26)).toLowerCase();
    if (f === ZERO_ADDRESS || t === ZERO_ADDRESS) {
      _nftContractAddr = log.address.toLowerCase();
      console.log(`[NFT contract] tespit edildi: ${_nftContractAddr}`);
      if (wsProvider && wsConnected) {
        try { wsProvider.on({ address: _nftContractAddr }, handleLiveLog); } catch (_) {}
      }
      ensureRecentTiers().catch(() => {});
      return;
    }
  }
}

function findNftMint(receipt) {
  for (const log of receipt.logs) {
    if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
    if (log.topics.length !== 4) continue;
    if (_nftContractAddr && log.address.toLowerCase() !== _nftContractAddr) continue;
    const f = ('0x' + log.topics[1].slice(26)).toLowerCase();
    if (f !== ZERO_ADDRESS) continue;
    const to = ('0x' + log.topics[2].slice(26)).toLowerCase();
    const nftId = BigInt(log.topics[3]).toString();
    return { nftId, to };
  }
  return null;
}

function findAllNftMints(receipt) {
  const mints = [];
  for (const log of receipt.logs) {
    if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
    if (log.topics.length !== 4) continue;
    if (_nftContractAddr && log.address.toLowerCase() !== _nftContractAddr) continue;
    const f = ('0x' + log.topics[1].slice(26)).toLowerCase();
    if (f !== ZERO_ADDRESS) continue;
    const to = ('0x' + log.topics[2].slice(26)).toLowerCase();
    const nftId = BigInt(log.topics[3]).toString();
    mints.push({ nftId, to });
  }
  return mints;
}

function findNftBurn(receipt) {
  for (const log of receipt.logs) {
    if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
    if (log.topics.length !== 4) continue;
    if (_nftContractAddr && log.address.toLowerCase() !== _nftContractAddr) continue;
    const to = ('0x' + log.topics[2].slice(26)).toLowerCase();
    if (to !== ZERO_ADDRESS) continue;
    const from = ('0x' + log.topics[1].slice(26)).toLowerCase();
    const nftId = BigInt(log.topics[3]).toString();
    return { nftId, from };
  }
  return null;
}

// Find tier by locating the buy() parameter block inside ANY calldata.
//
// buy(uint64 batchId, uint8 tier, uint256 seed, uint256 nonce, uint256 deadline)
// is encoded as 5 consecutive 32-byte static slots, so the block appears
// verbatim no matter how the call is wrapped (EOA direct, smart-contract
// wallet execute()/executeBatch(), Safe multiSend(), or any ERC-4337 bundler).
//
// The scan slides byte-by-byte (handles every wrapper byte-alignment) and
// validates the FULL signature shape so false positives are impossible:
//   slot0 batchId  : ≤ 10^6           → 29 leading zero bytes
//   slot1 tier     : ∈ {1,2,3}
//   slot2 seed     : ≥ 2^200          → keccak entropy; rejects 20-byte
//                                        addresses (~2^159) that appear as
//                                        call targets in batched calldata
//   slot4 deadline : 10^9 … 10^10     → a unix timestamp (anchor)
// A random/adversarial blob satisfying all four simultaneously is ~2^-200.
function findTierByPattern(data) {
  return findBuyByPattern(data)?.tier ?? null;
}

// Same scan, returning both buy() parameters that identify the series:
// { tier, batchId }.
function findBuyByPattern(data) {
  const hex = (data.startsWith('0x') ? data.slice(2) : data).toLowerCase();
  const SEED_MIN     = 1n << 200n;
  const DEADLINE_MIN = 1_000_000_000n;   // ~2001
  const DEADLINE_MAX = 10_000_000_000n;  // ~2286
  for (let i = 0; i + 320 <= hex.length; i += 2) {
    try {
      const tierVal = BigInt('0x' + hex.slice(i + 64, i + 128));
      if (tierVal < 1n || tierVal > 3n) continue;
      const batchVal = BigInt('0x' + hex.slice(i, i + 64));
      if (batchVal > 1_000_000n) continue;
      const seedVal = BigInt('0x' + hex.slice(i + 128, i + 192));
      if (seedVal < SEED_MIN) continue;
      const deadlineVal = BigInt('0x' + hex.slice(i + 256, i + 320));
      if (deadlineVal < DEADLINE_MIN || deadlineVal > DEADLINE_MAX) continue;
      return { tier: Number(tierVal), batchId: Number(batchVal) };
    } catch (_) {}
  }
  return null;
}

// Extract tier from calldata — wallet-agnostic.
//
// The (uint64 batchId, uint8 tier, uint256 seed) triplet is a contiguous run
// of static-ABI bytes, so it appears VERBATIM in the transaction calldata no
// matter how the call is wrapped:
//   • EOA direct buy()
//   • Smart-contract wallet execute(addr, val, bytes)
//   • Base App / Coinbase Smart Wallet (executeBatch / multicall)
//   • Any ERC-4337 bundler (handleOps v0.6 / v0.7 PackedUserOperation)
//
// Strategy:
//   1. If it's an EntryPoint handleOps call, try to decode and scan each
//      UserOperation's inner callData first (most precise).
//   2. ALWAYS fall back to a raw byte-pattern scan over the entire calldata.
//      The batchId ≤ 10^6 constraint forces 29 leading zero bytes in that
//      slot, so a false positive in arbitrary data (e.g. a signature blob) is
//      astronomically unlikely (~256^-29). This makes detection robust for
//      every wallet/bundler type, even ones whose ABI we cannot decode.
function tierFromCalldata(data) {
  const buy = buyFromCalldata(data);
  if (buy) noteBatch(buy);
  return buy?.tier ?? null;
}

function buyFromCalldata(data) {
  if (!data || data.length < 10) return null;
  const sel = data.slice(0, 10).toLowerCase();

  if (sel === EP_HANDLEOPS_SEL) {
    try {
      const [ops] = getEpIface().decodeFunctionData('handleOps', data);
      for (const op of ops) {
        const inner = op.callData ?? op[3];
        if (!inner || inner === '0x' || inner.length < 10) continue;
        const b = findBuyByPattern(inner);
        if (b) return b;
      }
    } catch (_) {}
    // Decode failed (unknown UserOp layout) → universal raw scan below.
  }

  // Universal fallback: scan the full raw calldata for the triplet.
  return findBuyByPattern(data);
}

// Newest series (batchId) seen per tier in buy() calls. Used as the argument
// when probing the coordinator's per-series view functions (/kontrat).
const latestBatch = { 1: null, 2: null, 3: null };
function noteBatch({ tier, batchId }) {
  if (latestBatch[tier] === null || batchId > latestBatch[tier]) latestBatch[tier] = batchId;
}

// Fallback: scan coordinator BUY event / NFT custom event topics for a
// value in {1,2,3} that isn't a known minted NFT ID. Used only when
// calldata is unavailable (e.g. very old recovery TXs).
function findBuyTierFromLogs(receipt, mintedNftIds) {
  const nftIdSet = new Set((mintedNftIds || []).map(id => BigInt(id)));
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== CONTRACT_LOWER) continue;
    if (!log.topics[0]?.toLowerCase().startsWith(BUY_EVENT_PREFIX)) continue;
    for (let i = 1; i < log.topics.length; i++) {
      try {
        const val = BigInt(log.topics[i]);
        if (val >= 1n && val <= 3n && !nftIdSet.has(val)) return Number(val);
      } catch (_) {}
    }
  }
  for (const log of receipt.logs) {
    if (_nftContractAddr && log.address.toLowerCase() !== _nftContractAddr) continue;
    if (!log.topics[0]?.toLowerCase().startsWith(NFT_CUSTOM_PREFIX)) continue;
    for (let i = 1; i < log.topics.length; i++) {
      try {
        const val = BigInt(log.topics[i]);
        if (val >= 1n && val <= 3n && !nftIdSet.has(val)) return Number(val);
      } catch (_) {}
    }
  }
  return null;
}

function findUsdcPayment(receipt, payer) {
  let total = 0n;
  for (const log of receipt.logs) {
    if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
    if (log.topics.length < 3) continue;
    if (log.address.toLowerCase() !== USDC_LOWER) continue;
    const f = ('0x' + log.topics[1].slice(26)).toLowerCase();
    if (f !== payer) continue;
    if (!log.data || log.data === '0x') continue;
    total += BigInt(log.data);
  }
  return Number(total) / 1e6;
}

// The mint tx of a card, looked up on the NFT contract's instance history.
// (This used to query the coordinator address, which has no NFT instances,
// so it always 404'd and then disabled itself for the rest of the run.)
async function findMintTxBlockscout(nftId) {
  if (!_nftContractAddr) return null;
  try {
    const url = `https://base.blockscout.com/api/v2/tokens/${_nftContractAddr}/instances/${nftId}/transfers`;
    const r = await axios.get(url, { timeout: 10000 });
    for (const t of r.data?.items || []) {
      const fromHash = (t.from?.hash || t.from || '').toLowerCase();
      if (fromHash === ZERO_ADDRESS) return t.transaction_hash || t.tx_hash || t.hash || null;
    }
  } catch (_) {}
  return null;
}

// RPCs cap eth_getLogs block ranges differently (Alchemy's free tier allows
// only 10 blocks). Ranges are queried in chunks; the chunk size is halved
// whenever a range is refused and the working size is remembered, so history
// scans succeed on any plan instead of failing silently.
let logsSpan = 2000;
async function getLogsChunked(filter, fromBlock, toBlock) {
  const out = [];
  let start = fromBlock;
  while (start <= toBlock) {
    const end = Math.min(toBlock, start + logsSpan - 1);
    try {
      out.push(...await provider.getLogs({ ...filter, fromBlock: start, toBlock: end }));
      start = end + 1;
    } catch (e) {
      if (logsSpan <= 10) throw e;
      logsSpan = Math.max(10, Math.floor(logsSpan / 2));
    }
  }
  return out;
}

async function findMintTxOnchain(nftId) {
  if (!_nftContractAddr) return null;
  const topics = [TRANSFER_TOPIC, '0x' + '0'.repeat(64), null, '0x' + BigInt(nftId).toString(16).padStart(64, '0')];
  try {
    const latest = await provider.getBlockNumber();
    // Newest blocks first with a bounded request budget: the token-id filter
    // keeps each response tiny, the budget keeps one unknown card from
    // hammering the RPC when only small ranges are allowed.
    let to = latest, budget = 200;
    while (to > 0 && budget-- > 0 && latest - to < 1_500_000) {
      const from = Math.max(0, to - logsSpan + 1);
      try {
        const logs = await provider.getLogs({ address: _nftContractAddr, topics, fromBlock: from, toBlock: to });
        if (logs.length) return logs[0].transactionHash;
        to = from - 1;
      } catch (_) {
        if (logsSpan <= 10) return null;
        logsSpan = Math.max(10, Math.floor(logsSpan / 2));
      }
    }
  } catch (_) {}
  return null;
}

async function findMintTxHash(nftId) {
  const fromBs = await findMintTxBlockscout(nftId);
  if (fromBs) return { hash: fromBs, src: 'blockscout' };
  const fromRpc = await findMintTxOnchain(nftId);
  if (fromRpc) return { hash: fromRpc, src: 'getLogs' };
  return null;
}

async function recoverTierFromBuyTx(nftId) {
  // The warm-up history scan may hold the answer, but don't let a slow scan
  // block claim processing for minutes — fall through to a direct lookup.
  if (_recentTiersPromise) await Promise.race([_recentTiersPromise, sleep(5000)]).catch(() => {});
  if (nftToTier.has(nftId)) return nftToTier.get(nftId).tier;
  try {
    const found = await findMintTxHash(nftId);
    if (!found) return null;
    const { hash: buyTxHash, src: lookupSrc } = found;
    const [buyTx, buyReceipt] = await Promise.all([
      provider.getTransaction(buyTxHash).catch(() => null),
      provider.getTransactionReceipt(buyTxHash).catch(() => null),
    ]);
    if (!buyReceipt) return null;
    const allMints = findAllNftMints(buyReceipt);
    const tier = tierFromCalldata(buyTx?.data || '') ?? findBuyTierFromLogs(buyReceipt, allMints.map(m => m.nftId));
    if (tier) {
      const block = await provider.getBlock(buyReceipt.blockNumber).catch(() => null);
      const paid = allMints.length ? findUsdcPayment(buyReceipt, allMints[0].to) : 0;
      for (const m of allMints) {
        nftToTier.set(m.nftId, { tier, buyer: m.to, buyTxHash, buyTs: block?.timestamp || 0, paid });
      }
    }
    return tier;
  } catch (_) {
    return null;
  }
}

async function ensureRecentTiers() {
  if (_recentTiersPromise) return _recentTiersPromise;
  if (!_nftContractAddr) return;
  _recentTiersPromise = (async () => {
    try {
      const latest = await provider.getBlockNumber();
      const fromBlock = Math.max(0, latest - 9000);
      const fromZeroTopic = '0x' + '0'.repeat(64);
      // Every buy mints a card, so the NFT mint logs alone cover all buys.
      const mintLogs = await getLogsChunked(
        { address: _nftContractAddr, topics: [TRANSFER_TOPIC, fromZeroTopic] }, fromBlock, latest);
      const allHashes = new Set(mintLogs.map(l => l.transactionHash));
      console.log(`[TIER] geçmiş tarama: ${allHashes.size} buy tx (son 9000 blok)`);

      for (const hash of allHashes) {
        try {
          const [tx, receipt] = await Promise.all([
            provider.getTransaction(hash).catch(() => null),
            provider.getTransactionReceipt(hash).catch(() => null),
          ]);
          if (!receipt || receipt.status !== 1) continue;
          const mints = findAllNftMints(receipt);
          if (!mints.length) continue;
          const tier = tierFromCalldata(tx?.data || '') ?? findBuyTierFromLogs(receipt, mints.map(m => m.nftId));
          if (!tier) continue;
          const block = await provider.getBlock(receipt.blockNumber).catch(() => null);
          const paid = findUsdcPayment(receipt, mints[0].to);
          for (const m of mints) {
            if (!nftToTier.has(m.nftId)) {
              nftToTier.set(m.nftId, { tier, buyer: m.to, buyTxHash: hash, buyTs: block?.timestamp || 0, paid });
            }
          }
        } catch (_) {}
      }
    } catch (e) {
      console.error('[TIER] geçmiş tarama hatası:', e.message);
      _recentTiersPromise = null;
      throw e;
    }
  })();
  try { await _recentTiersPromise; } catch (_) {}
  return _recentTiersPromise;
}

// ── /kontrat: contract discovery ─────────────────────────────────────────
// Reads the verified ABI of the coordinator (and its implementation if it is
// a proxy) and of the NFT contract from Blockscout, lists every read-only
// function and calls the ones that take no argument, a tier (1–3) or a series
// id (the newest batchId seen in buy() per tier). Used to find where the
// contract keeps how many packages a series has and how many are sold.
async function fetchVerifiedAbi(addr) {
  const r = await axios.get(`https://base.blockscout.com/api/v2/smart-contracts/${addr}`, { timeout: 15000 });
  const d = r.data || {};
  const impls = [
    ...(d.implementations || []).map(i => i.address || i.address_hash),
    d.implementation_address,
  ].filter(a => a && a.toLowerCase() !== addr.toLowerCase());
  let abi = Array.isArray(d.abi) ? d.abi : [];
  const names = [d.name || '?'];
  for (const impl of [...new Set(impls)]) {
    try {
      const ri = await axios.get(`https://base.blockscout.com/api/v2/smart-contracts/${impl}`, { timeout: 15000 });
      if (Array.isArray(ri.data?.abi)) abi = abi.concat(ri.data.abi);
      names.push(`impl ${ri.data?.name || '?'} ${impl}`);
    } catch (e) { names.push(`impl ${impl} (ABI alınamadı: ${e.message})`); }
  }
  return { abi, names, verified: d.is_verified !== false && abi.length > 0 };
}

const fmtResult = (v) => JSON.stringify(v, (_, x) => typeof x === 'bigint' ? x.toString() : x);

function probeArgs(input) {
  const t = input.type, n = (input.name || '').toLowerCase();
  if (!/^u?int\d*$/.test(t)) return null;
  const batches = [1, 2, 3].map(tr => latestBatch[tr]).filter(b => b !== null);
  if (/batch|series|seri|round|id/.test(n) && batches.length) return [...new Set(batches)];
  return [1, 2, 3];
}

async function probeContract(label, addr) {
  const lines = [`━━ ${label} ${addr}`];
  let info;
  try { info = await fetchVerifiedAbi(addr); }
  catch (e) { return lines.concat(`❌ Blockscout ABI alınamadı: ${e.message}`); }
  lines.push(`Ad: ${info.names.join(' | ')}`);
  if (!info.verified) return lines.concat('❌ Kontrat doğrulanmamış (ABI yok)');

  // Proxy + implementation ABIs overlap; keep one fragment per signature.
  const views = [...new Map(info.abi
    .filter(f => f.type === 'function' && ['view', 'pure'].includes(f.stateMutability))
    .map(f => [`${f.name}(${(f.inputs || []).map(i => i.type).join(',')})`, f])).values()];
  lines.push(`Okuma fonksiyonu: ${views.length}`);
  const c = new ethers.Contract(addr, views, provider);
  for (const f of views) {
    const key = `${f.name}(${(f.inputs || []).map(i => i.type).join(',')})`;
    const sig = `${f.name}(${(f.inputs || []).map(i => `${i.type} ${i.name || ''}`.trim()).join(', ')})`;
    const outs = (f.outputs || []).map(o => `${o.type}${o.name ? ' ' + o.name : ''}`).join(', ');
    const argSets = (f.inputs || []).length === 0 ? [[]]
      : (f.inputs.length === 1 && probeArgs(f.inputs[0])) ? probeArgs(f.inputs[0]).map(a => [a]) : null;
    if (!argSets) { lines.push(`• ${sig} → (${outs}) [çağrılmadı]`); continue; }
    const results = [];
    for (const args of argSets) {
      try {
        const fn = c.getFunction(key);
        const v = await Promise.race([fn.staticCall(...args), sleep(8000).then(() => { throw new Error('timeout'); })]);
        results.push(`${args.length ? args[0] + ': ' : ''}${fmtResult(v).slice(0, 160)}`);
      } catch (e) { results.push(`${args.length ? args[0] + ': ' : ''}hata ${(e.shortMessage || e.message || '').slice(0, 50)}`); }
    }
    lines.push(`• ${sig} → (${outs})\n    ${results.join('\n    ')}`);
  }
  return lines;
}

async function probeContracts() {
  const head = [
    `🔎 Kontrat keşfi ${VERSION}`,
    `Son görülen seri (batchId): mavi=${latestBatch[1] ?? '?'} yeşil=${latestBatch[2] ?? '?'} mor=${latestBatch[3] ?? '?'}`,
  ];
  const coord = await probeContract('COORDINATOR', CONTRACT);
  const nft   = _nftContractAddr ? await probeContract('NFT', _nftContractAddr) : [];
  return head.concat(coord, nft).join('\n');
}

// Telegram caps messages at 4096 chars; split on line boundaries.
function chunkText(text, max = 3900) {
  const out = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if (cur.length + line.length + 1 > max) { out.push(cur); cur = ''; }
    cur += (cur ? '\n' : '') + line.slice(0, max);
  }
  if (cur) out.push(cur);
  return out;
}

function nftIdFromCalldata(data) {
  if (!data || data.length < 74) return null;
  try { return BigInt('0x' + data.slice(10, 74)).toString(); }
  catch (_) { return null; }
}

function collectReceived(receipt, recipient) {
  const received = {};
  const sources  = {};
  const fromOther = {};
  for (const log of receipt.logs) {
    if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
    if (log.topics.length !== 3) continue;
    const to      = ('0x' + log.topics[2].slice(26)).toLowerCase();
    const fromLog = ('0x' + log.topics[1].slice(26)).toLowerCase();
    if (to !== recipient) continue;
    if (!log.data || log.data === '0x') continue;
    const tokenAddr = log.address.toLowerCase();
    const amt = BigInt(log.data);
    if (fromLog === CONTRACT_LOWER) {
      received[tokenAddr] = (received[tokenAddr] ?? 0n) + amt;
      (sources[tokenAddr] ??= new Set()).add('C');
    } else if (fromLog === ZERO_ADDRESS) {
      received[tokenAddr] = (received[tokenAddr] ?? 0n) + amt;
      (sources[tokenAddr] ??= new Set()).add('M');
    } else {
      fromOther[tokenAddr] = (fromOther[tokenAddr] ?? 0n) + amt;
    }
  }
  if (Object.keys(received).length)
    return { received, usedFallback: false, src: 'mixed', sources };
  return { received: fromOther, usedFallback: true, src: 'other', sources: {} };
}

async function calcTotalUsd(received, sources, capUsd = PER_TOKEN_MAX_USD) {
  let totalUsd = 0;
  const tokenSummary = [];
  const tokenDetail  = [];
  const droppedSummary = [];

  const commit = (addr, info, human, price, label) => {
    const usd  = human * price;
    const psrc = priceCache[addr.toLowerCase()]?.src || '?';
    const fsrc = sources && sources[addr] ? Array.from(sources[addr]).sort().join('') : '?';
    totalUsd += usd;
    tokenSummary.push(`${info.symbol}=$${usd.toFixed(4)}`);
    tokenDetail.push(`${info.symbol}[${fsrc}] ${human.toFixed(6)} @ $${price.toFixed(8)}[${psrc}${label}] = $${usd.toFixed(4)}`);
  };

  const addPriced = async (addr, info, human, price, label) => {
    const usd = human * price;
    if (usd < 0.0001) return;
    if (usd > capUsd) {
      // Higher than a normal prize token for this tier. This is EITHER a real
      // jackpot prize OR an aggregator price coming from a dust/scam pool.
      // Consult on-chain reserves (Uniswap/Aerodrome) — the ground truth a fake
      // pool can't spoof — and INCLUDE the token at that verified price.
      //   • Genuine jackpot prize (e.g. SCRATCH): on-chain confirms its value →
      //     it counts toward Total Value, so jackpots actually trigger.
      //   • KAITO-style 40x misprice: on-chain reveals the real (low) price →
      //     corrected down instead of inflating the total.
      // Only drop when the token can't be verified on-chain at all, or even the
      // on-chain price is absurd (> $100 absolute backstop) — i.e. unreliable.
      const onchain = await onchainPriceUsd(addr, info.decimals);
      if (onchain && human * onchain <= PER_TOKEN_MAX_USD) {
        priceCache[addr.toLowerCase()] = { price: onchain, at: Date.now(), src: 'onchain' };
        commit(addr, info, human, onchain, label ? `${label},chk` : 'chk');
        return;
      }
      droppedSummary.push(`${info.symbol}=$${usd.toFixed(2)}(OUTLIER>$${capUsd}, doğrulanamadı)`);
      return;
    }
    commit(addr, info, human, price, label);
  };

  const pending = [];
  for (const [addr, rawAmt] of Object.entries(received)) {
    try {
      const info  = await getTokenInfo(addr);
      const human = Number(ethers.formatUnits(rawAmt, info.decimals));
      const price = await getTokenPriceUsd(addr);
      if (!price) { pending.push({ addr, info, human }); continue; }
      await addPriced(addr, info, human, price, '');
    } catch (_) {}
  }

  if (pending.length) {
    await new Promise(r => setTimeout(r, 2000));
    for (const { addr, info, human } of pending) {
      try {
        delete priceCache[addr.toLowerCase()];
        const price = await getTokenPriceUsd(addr);
        if (!price) { droppedSummary.push(`${info.symbol}=NO_PRICE`); continue; }
        await addPriced(addr, info, human, price, '*retry');
      } catch (_) {}
    }
  }

  return { totalUsd, tokenSummary, tokenDetail, droppedSummary };
}

// Returns 'ok' | 'buy' | 'skip' | 'dup' | 'retry'. On 'retry' the tx is
// released from processedTxs so the retry queue can run it again — a tx is
// never marked done by a transient failure (that used to lose claims for good).
async function processTx(txHash, from, data, blockNum, blockTs, receipt = null) {
  if (processedTxs.has(txHash)) return 'dup';
  processedTxs.add(txHash);
  if (processedTxs.size > 20000) {
    const arr = [...processedTxs]; processedTxs = new Set(arr.slice(-10000));
  }
  const retry = (why) => {
    processedTxs.delete(txHash);
    console.log(`[RETRY?] ${txHash.slice(0,10)} ${why}`);
    return 'retry';
  };

  const isRecentTx = blockTs >= BOT_START_TS - LIVE_WINDOW_SEC;

  if (!receipt) {
    try { receipt = await provider.getTransactionReceipt(txHash); } catch (e) { return retry('receipt hatası'); }
  }
  if (!receipt) return retry('receipt henüz yok');
  if (receipt.status === 0) return 'skip';

  rememberNftContract(receipt);

  // BUY TX — detect tier from calldata (all param slots) or event topics.
  // Silently register; no notification, no routine log.
  const allMints = findAllNftMints(receipt);
  if (allMints.length) {
    const mintedIds = allMints.map(m => m.nftId);
    const paid = findUsdcPayment(receipt, allMints[0].to);
    let fallbackTier;
    let anyTier = false;
    for (const m of allMints) {
      // The NFT contract is the source of truth for tier and series; calldata
      // and event parsing remain as a fallback if the read fails.
      const card = await readCard(m.nftId, receipt.blockNumber);
      if (card) addSold(card.tier, card.batchId, m.nftId, true);
      const tier = card?.tier ?? (fallbackTier ??= tierFromCalldata(data) ?? findBuyTierFromLogs(receipt, mintedIds));
      if (!tier) continue;
      anyTier = true;
      nftToTier.set(m.nftId, { tier, batchId: card?.batchId ?? null, buyer: m.to, buyTxHash: txHash, buyTs: blockTs, paid });
    }
    if (!anyTier && (!isLoadingHistory || isRecentTx)) {
      // Unknown tier on a real mint signals a contract/format change — keep.
      console.log(`[BUY?] tier yok sel=${data?.slice(0,10)} ids=[${mintedIds.join(',')}] | ${txHash.slice(0,10)}`);
    }
    return 'buy';
  }

  // CLAIM TX
  const burn = findNftBurn(receipt);
  const claimer = burn ? burn.from.toLowerCase() : from.toLowerCase();

  const { received, sources } = collectReceived(receipt, claimer);
  if (!Object.keys(received).length) return 'skip';

  let claimedNftId = burn?.nftId ?? nftIdFromCalldata(data);
  const tag = `#${claimedNftId} ${txHash.slice(0,10)}`;

  let entry = claimedNftId ? nftToTier.get(claimedNftId) : null;
  // Read the card as it was just before this claim burned it.
  const card = claimedNftId ? await readCard(claimedNftId, receipt.blockNumber - 1) : null;
  let tier = card?.tier ?? entry?.tier ?? null;
  let batchId = card?.batchId ?? entry?.batchId ?? null;

  const { totalUsd, droppedSummary } = await calcTotalUsd(received, sources, perTokenCapUsd(tier));
  if (totalUsd <= 0) {
    if (droppedSummary.some(d => d.includes('NO_PRICE'))) return retry(`fiyat alınamadı ${tag}`);
    stats.skipNoValue++;
    console.log(`[SKIP] değer 0 ${tag} ${droppedSummary.join(' ')}`);
    return 'skip';
  }

  if (tier === null && claimedNftId && (!isLoadingHistory || isRecentTx)) {
    tier = await recoverTierFromBuyTx(claimedNftId);
    entry = claimedNftId ? nftToTier.get(claimedNftId) : null; // re-read after recovery
  }

  // Skip free packages — only notify for cards bought with ~1 USDC.
  if (entry && typeof entry.paid === 'number' && entry.paid < MIN_PAID_USDC) {
    stats.skipFree++;
    console.log(`[SKIP] ücretsiz paket (paid=$${entry.paid}) ${tag}`);
    return 'skip';
  }

  if (tier === null) {
    stats.skipNoTier++;
    return retry(`tier bulunamadı ${tag} $${totalUsd.toFixed(2)}`);
  }
  stats.claims++;

  const tierInfo = TIER_INFO[tier];
  const state = ts(tier);
  const s = series[tier];
  if (batchId === null) batchId = s.current; // unknown series → assume current

  if (state.history.length > 0) {
    const dir = totalUsd >= state.history[0].usd ? 'up' : 'down';
    state.streak    = dir === state.streakDir ? state.streak + 1 : 1;
    state.streakDir = dir;
  } else {
    state.streak = 1; state.streakDir = null;
  }

  state.count++;
  state.history.unshift({ usd: totalUsd, ts: blockTs * 1000, hash: txHash, claimer: from, batchId });
  if (state.history.length > 300) state.history.pop();

  // Jackpot: Total Value inside the tier's band (mavi $4–8 · yeşil $7–15 ·
  // mor $15–30), counted per series of the claimed card.
  const { jackpotMin, jackpotMax, jackpotTotal } = tierInfo;
  const isJackpot = totalUsd >= jackpotMin && totalUsd <= jackpotMax;
  if (isJackpot && batchId !== null) {
    s.jackpots.set(batchId, (s.jackpots.get(batchId) || 0) + 1);
    stateRev++;
  }

  if (isLoadingHistory && !isRecentTx) return 'ok';

  const date = new Date(blockTs * 1000).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
  const txUrl = `https://basescan.org/tx/${txHash}`;
  const inSeries = state.history.filter(h => h.batchId === batchId);
  const seriesAvg = inSeries.reduce((a, h) => a + h.usd, 0) / (inSeries.length || 1);
  const jackpotsHere = batchId !== null ? (s.jackpots.get(batchId) || 0) : 0;

  const avgLine = [5, 10, 15, 20, 25, 50, 100, 200]
    .map(n => { const v = calcAvg(state.history, n); return v !== null ? `Avg${n}:$${v.toFixed(2)}` : null; })
    .filter(Boolean).join(' | ');

  const msg = [
    `${tierInfo.emoji} Total Value: $${totalUsd.toFixed(2)} [${tierInfo.name}]`,
    `📦 ${seriesLine(tier)}`,
    batchId !== null && s.current !== null && batchId !== s.current ? `🃏 Bu kart önceki seriden: #${batchId}` : null,
    `🎰 Jackpot${batchId !== null ? ` (seri #${batchId})` : ''}: ${jackpotsHere}/${jackpotTotal}${isJackpot ? ' 🎉 JACKPOT!' : ''}`,
    `📍 Seri Avg: $${seriesAvg.toFixed(2)} (${inSeries.length} claim)`,
    `🔴 Streak: ${state.streak}`,
    avgLine ? `📊 ${avgLine}` : null,
    `👤 ${claimer}`,
    `🕐 ${date} | <a href="${txUrl}">TX</a>`,
  ].filter(Boolean).join('\n');

  console.log(`[✓] ${tierInfo.name} $${totalUsd.toFixed(2)} seri #${batchId} ${seriesLine(tier)} #${claimedNftId}`);
  await sendNotification(msg);
  return 'ok';
}

// Fetches a tx and processes it; anything that fails transiently goes to the
// retry queue. Returns true once the tx is fully handled.
async function handleTxHash(hash) {
  if (inFlight.has(hash)) return true;
  inFlight.add(hash);
  try {
    const bundle = await fetchTxBundle(hash);
    if (!bundle) { scheduleRetry(hash, 'tx alınamadı'); return false; }
    const status = await processTx(hash, bundle.tx.from, bundle.tx.data || '',
      bundle.receipt.blockNumber, bundle.block?.timestamp || 0, bundle.receipt);
    if (status === 'retry') { scheduleRetry(hash, 'işlenemedi'); return false; }
    retryQueue.delete(hash);
    return true;
  } catch (e) {
    console.error(`[TX] ${hash.slice(0,10)}: ${e.message?.slice(0,80)}`);
    scheduleRetry(hash, 'hata');
    return false;
  } finally {
    inFlight.delete(hash);
  }
}

function scheduleRetry(hash, why) {
  const r = retryQueue.get(hash) || { tries: 0 };
  r.tries++;
  if (r.tries > RETRY_MAX) {
    retryQueue.delete(hash);
    console.log(`[RETRY] vazgeçildi ${hash.slice(0,10)} (${why}, ${RETRY_MAX} deneme)`);
    return;
  }
  r.due = Date.now() + 15_000 * r.tries;
  retryQueue.set(hash, r);
  stats.retries++;
}

async function processDueRetries() {
  const now = Date.now();
  for (const [hash, r] of [...retryQueue]) {
    if (r.due <= now) await handleTxHash(hash);
  }
}

async function diagnoseTx(txHash) {
  const lines = [`🔍 TX: <code>${txHash}</code>`];
  if (typeof txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    lines.push(`❌ Geçersiz TX hash. 0x + 64 hex karakter bekleniyor. Şu an: ${txHash?.length ?? 0} karakter.`);
    return lines.join('\n');
  }
  try {
    const tx = await provider.getTransaction(txHash);
    if (!tx) { lines.push('❌ TX bulunamadı'); return lines.join('\n'); }
    lines.push(`📝 Calldata: ${(tx.data||'').length} char, sel ${(tx.data||'').slice(0,10)}`);
    lines.push(`👤 From: ${tx.from}`);

    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt) { lines.push('❌ Receipt: null'); return lines.join('\n'); }
    lines.push(`📜 Status: ${receipt.status === 1 ? '✅' : '❌'}`);

    const mint = findNftMint(receipt);
    const burn = findNftBurn(receipt);
    if (mint) {
      const all = findAllNftMints(receipt);
      const mintedIds = all.map(m => m.nftId);
      const tier = findBuyTierFromLogs(receipt, mintedIds);
      const paid = findUsdcPayment(receipt, mint.to);
      lines.push(`🛒 BUY TX: ${all.length} mint, paid=$${paid.toFixed(2)}, tier=${tier ?? '?'}(${TIER_INFO[tier]?.name ?? 'bilinmiyor'})`);
      lines.push(`   NFT id'ler: [${all.map(m => '#'+m.nftId).join(', ')}] → ${mint.to.slice(0,12)}`);
      if (tier && nftToTier.has(mint.nftId)) lines.push(`  ✓ Map'te: tier=${tier}`);
    } else if (burn) {
      lines.push(`🔥 CLAIM TX: NFT #${burn.nftId} burn from ${burn.from.slice(0,12)}`);
      if (nftToTier.has(burn.nftId)) {
        const m = nftToTier.get(burn.nftId);
        lines.push(`  ✓ Map'te tier=${m.tier} (${TIER_INFO[m.tier]?.name})`);
      } else {
        lines.push(`  ⚠️ NFT #${burn.nftId} map'te yok — fallback'e düşer`);
      }
    } else {
      lines.push(`❓ Mint/burn yok`);
    }

    const { received, src, sources } = collectReceived(receipt, tx.from.toLowerCase());
    lines.push(`💸 Recipient transferi: ${Object.keys(received).length} (src=${src})`);
    if (Object.keys(received).length) {
      const diagTier = burn && nftToTier.has(burn.nftId) ? nftToTier.get(burn.nftId).tier : null;
      const { totalUsd, tokenDetail, droppedSummary } = await calcTotalUsd(received, sources, perTokenCapUsd(diagTier));
      for (const t of tokenDetail)    lines.push(`  ✓ ${t}`);
      for (const d of droppedSummary) lines.push(`  ✗ ${d}`);
      lines.push(`💰 Toplam: $${totalUsd.toFixed(4)}`);
    }

    // Full event dump — show ALL topics for every event
    lines.push(`\n🧪 Tüm event'ler (${receipt.logs.length} toplam):`);
    for (let i = 0; i < receipt.logs.length; i++) {
      const log = receipt.logs[i];
      const addr = log.address.toLowerCase();
      const tag  = addr === CONTRACT_LOWER ? '⭐CONTRACT'
                 : addr === USDC_LOWER      ? '💵USDC'
                 : addr === _nftContractAddr ? '🖼NFT'
                 : `${addr.slice(0,10)}`;
      const t0 = log.topics[0] || '-';
      let detail = '';
      if (t0.toLowerCase() === TRANSFER_TOPIC) {
        if (log.topics.length === 4) {
          const f  = '0x' + log.topics[1].slice(26);
          const t  = '0x' + log.topics[2].slice(26);
          const id = BigInt(log.topics[3]).toString();
          detail = `ERC721 ${f.slice(0,10)}→${t.slice(0,10)} id=${id}`;
        } else if (log.topics.length === 3) {
          const f = '0x' + log.topics[1].slice(26);
          const t = '0x' + log.topics[2].slice(26);
          const v = log.data && log.data !== '0x' ? BigInt(log.data).toString() : '0';
          detail = `ERC20  ${f.slice(0,10)}→${t.slice(0,10)} val=${v.slice(0,12)}`;
        }
      } else {
        // Show full topic[0] + all other topics
        const extraTopics = log.topics.slice(1).map((t, j) => {
          const big = (() => { try { return BigInt(t); } catch(_) { return null; } })();
          return `t${j+1}=${big !== null && big < 10000n ? big.toString() : t.slice(0,18)}`;
        }).join(' ');
        detail = `sig=${t0.slice(0,18)} ${extraTopics} data=${(log.data||'').slice(0,18)}`;
      }
      lines.push(`  ${String(i).padStart(2,'0')} [${tag}] ${detail}`);
    }

    if (processedTxs.has(txHash)) lines.push(`\n⚠️ Bu TX zaten işlendi`);
    lines.push(`📇 NFT map: ${nftToTier.size} | chat: ${registeredChats.size}`);
  } catch (e) {
    lines.push(`❌ Hata: ${e.message.slice(0, 200)}`);
  }
  return lines.join('\n');
}

// Tx hashes touching the coordinator or minting a card in [from, to], in chain
// order (so a buy is registered before a claim of the same card). Throws on
// RPC errors on purpose: the caller then retries the same range instead of
// skipping it — returning [] here used to silently drop whole block ranges.
async function scanRangeTxs(from, to) {
  const queries = [provider.getLogs({ address: CONTRACT_LOWER, fromBlock: from, toBlock: to })];
  if (_nftContractAddr) queries.push(provider.getLogs({
    address: _nftContractAddr, topics: [TRANSFER_TOPIC, '0x' + '0'.repeat(64)], fromBlock: from, toBlock: to,
  }));
  const logs = (await Promise.all(queries)).flat()
    .sort((a, b) => a.blockNumber - b.blockNumber || (a.index ?? 0) - (b.index ?? 0));
  return [...new Set(logs.map(l => l.transactionHash))];
}

async function fetchTxBundle(hash) {
  const MAX_TRIES = 4;
  for (let i = 0; i < MAX_TRIES; i++) {
    try {
      const [tx, receipt] = await Promise.all([
        provider.getTransaction(hash),
        provider.getTransactionReceipt(hash),
      ]);
      if (tx && receipt) {
        const block = await provider.getBlock(receipt.blockNumber).catch(() => null);
        return { tx, receipt, block };
      }
    } catch (_) {}
    if (i < MAX_TRIES - 1) await new Promise(r => setTimeout(r, 500 * (i + 1)));
  }
  return null;
}

// WebSocket real-time event handler
async function handleLiveLog(log) {
  const txHash = log.transactionHash;
  if (!txHash || processedTxs.has(txHash) || retryQueue.has(txHash)) return;
  await handleTxHash(txHash);
}

async function startWsSubscription() {
  if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
  wsConnected = false;
  if (wsProvider) { try { await wsProvider.destroy(); } catch (_) {} wsProvider = null; }

  try {
    const wsp = new ethers.WebSocketProvider(ALCHEMY_WSS);
    await Promise.race([
      wsp.ready,
      new Promise((_, r) => setTimeout(() => r(new Error('WS connect timeout')), 15000)),
    ]);

    wsp.on({ address: CONTRACT_LOWER }, handleLiveLog);
    if (_nftContractAddr) wsp.on({ address: _nftContractAddr }, handleLiveLog);

    const onDisconnect = () => {
      if (!wsConnected) return;
      wsConnected = false;
      wsProvider  = null;
      console.log('[WS] Bağlantı kesildi — 5s sonra yeniden bağlanıyor');
      if (!wsReconnectTimer) wsReconnectTimer = setTimeout(startWsSubscription, 5000);
    };

    const socket = wsp.websocket;
    if (socket) {
      if (typeof socket.on === 'function') {
        socket.on('close', onDisconnect);
        socket.on('error', onDisconnect);
      } else {
        socket.onclose = onDisconnect;
        socket.onerror = onDisconnect;
      }
    }

    wsProvider  = wsp;
    wsConnected = true;
    console.log('[WS ✓] Alchemy WebSocket canlı takip başladı');
  } catch (e) {
    wsConnected = false;
    wsProvider  = null;
    console.log(`[WS ✗] ${(e.message || '').slice(0, 80)} — 15s sonra yeniden deneniyor`);
    wsReconnectTimer = setTimeout(startWsSubscription, 15000);
  }
}

// Alchemy's free tier refuses eth_getLogs ranges over 10 blocks, and a
// refused range used to be skipped silently — keep each poll inside the limit.
const POLL_SPAN = 10;

// One poll step. Returns true when caught up with the chain head.
async function pollOnce() {
  await processDueRetries();
  const cur = await provider.getBlockNumber();
  if (lastPollBlock === 0) lastPollBlock = cur - 1;
  if (cur <= lastPollBlock) return true;
  const from = lastPollBlock + 1;
  const to   = Math.min(cur, lastPollBlock + POLL_SPAN);
  for (const hash of await scanRangeTxs(from, to)) {
    if (processedTxs.has(hash) || retryQueue.has(hash)) continue;
    await handleTxHash(hash);
  }
  // Only advance once the range was read successfully; failed txs inside it
  // are already in the retry queue.
  lastPollBlock = to;
  stats.lastBlock = to;
  return to >= cur;
}

async function pollLoop() {
  let fails = 0;
  console.log('[POLL] Canlı izleme başlıyor...');
  while (true) {
    try {
      const caughtUp = await pollOnce();
      fails = 0;
      // When WS is live it handles real-time events; poll is the gap-filler.
      // While behind the chain head, keep going without sleeping.
      if (caughtUp) await sleep(wsConnected ? 6000 : 2500);
    } catch (e) {
      fails++;
      console.error(`[POLL] hata #${fails} (blok ${lastPollBlock + 1}):`, (e.message || '').slice(0, 100));
      if (fails >= 3) { await switchProvider(); fails = 0; }
      await sleep(Math.min((fails + 1) * 3000, 30000));
    }
  }
}

function buildTierMsg(tierNum) {
  const state    = ts(tierNum);
  const tierInfo = TIER_INFO[tierNum];
  const s        = series[tierNum];
  const inSeries = state.history.filter(h => h.batchId === s.current);
  const seriesAvg = inSeries.reduce((a, h) => a + h.usd, 0) / (inSeries.length || 1);
  const sEmoji   = state.streakDir === 'down' ? '🔴' : '🟢';
  const avgLines = [5, 10, 15, 20, 25, 50, 100, 200]
    .map(n => { const v = calcAvg(state.history, n); return v !== null ? `Avg${n}: $${v.toFixed(2)}` : null; })
    .filter(Boolean).join('\n');
  return [
    `${tierInfo.emoji} <b>${tierInfo.name.toUpperCase()} İstatistikleri</b> ${VERSION}`,
    `($${tierInfo.payUsd} USDC paket)`,
    '',
    `📦 ${seriesLine(tierNum)}`,
    `🎰 Jackpot (seri #${s.current ?? '?'}): ${s.current !== null ? (s.jackpots.get(s.current) || 0) : 0}/${tierInfo.jackpotTotal}`,
    `📍 Seri Avg: $${seriesAvg.toFixed(2)} (${inSeries.length} claim) | Toplam claim: ${state.count}`,
    `${sEmoji} Streak: ${state.streak}`,
    '',
    avgLines || 'Yetersiz veri',
  ].join('\n');
}

// One line per tier: current series and how many packages are left.
function seriesSummary() {
  return [1, 2, 3].map(t => `${TIER_INFO[t].emoji} ${TIER_INFO[t].name}: ${seriesLine(t)}`);
}

// Reminder shown on /start and /test until the chat is pinned via env var.
function channelIdHint(chatId) {
  if (CHANNEL_IDS.includes(String(chatId))) return null;
  return `📌 Redeploy sonrası bildirimler kesilmesin diye Railway → Variables'a ekle:\n<code>TELEGRAM_CHANNEL_ID=${chatId}</code>`;
}

async function startConversation(chatId) {
  await registerChat(chatId);

  const lines = [
    `👋 <b>Scratch Card Tracker</b> ${VERSION}`,
    '',
    '✅ Bu chat bildirim listesine eklendi.',
    channelIdHint(chatId),
    '',
    '📦 Seriler (zincirden okunuyor, elle giriş yok):',
    ...seriesSummary(),
    seriesScan.done ? null : `⏳ Geçmiş sayım: ${seriesScan.status}`,
  ].filter(l => l !== null);
  await bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML' });
}

async function main() {
  loadState();
  provider = await getProvider();
  bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

  // Persist state periodically and on shutdown (Railway sends SIGTERM on redeploy).
  setInterval(() => saveState(), 15_000);
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { saveState(true); process.exit(0); });

  bot.onText(/\/start/, (msg) => startConversation(msg.chat.id).catch(console.error));

  bot.onText(/\/track/, async (msg) => {
    await registerChat(msg.chat.id);
    const hint = channelIdHint(msg.chat.id);
    await bot.sendMessage(msg.chat.id, '✅ Bu chat bildirim listesine eklendi.' + (hint ? '\n' + hint : ''), { parse_mode: 'HTML' });
  });

  bot.onText(/\/stop/, async (msg) => {
    registeredChats.delete(String(msg.chat.id));
    saveState(true);
    await bot.sendMessage(msg.chat.id, '🔕 Bildirim listesinden çıkarıldı.');
  });

  bot.onText(/\/komut/, async (msg) => {
    await registerChat(msg.chat.id);
    const lines = [
      `📋 <b>Komut Listesi</b> ${VERSION}`,
      '',
      '/start — Botu başlat, döngü sayıcısını ayarla',
      '/track — Bu chati bildirim listesine ekle',
      '/stop — Bildirimleri durdur',
      '/test — Bot durumu',
      '/sc1 — 🔵 Mavi istatistikleri',
      '/sc2 — 🟢 Yeşil istatistikleri',
      '/sc3 — 🟣 Mor istatistikleri',
      '/kontrat — Kontratın okuma fonksiyonlarını ve değerlerini göster',
      '/komut — Bu listeyi göster',
      '/diag &lt;TX_HASH&gt; — TX analizi',
    ];
    await bot.sendMessage(msg.chat.id, lines.join('\n'), { parse_mode: 'HTML' });
  });

  bot.onText(/\/test/, async (msg) => {
    await registerChat(msg.chat.id);
    const lines = [
      `✅ <b>Test</b> ${VERSION}`,
      `📡 Kayıtlı chat: ${registeredChats.size} (bu chat: <code>${msg.chat.id}</code>)`,
      `📇 NFT map: ${nftToTier.size} | Sayılan kart: ${countedMints.size} | getLogs aralığı: ${logsSpan}`,
      `🔌 WebSocket: ${wsConnected ? '✅ aktif' : '❌ bağlı değil'} | RPC: ${rpcHost(RPCS[rpcIndex])}`,
      `⛓ Son taranan blok: ${stats.lastBlock || '-'}`,
      `🧾 Claim: ${stats.claims} | Gönderilen bildirim: ${stats.notified} | Kuyrukta: ${undelivered.length}`,
      `⏭ Atlanan — ücretsiz: ${stats.skipFree}, değer 0: ${stats.skipNoValue}, tier yok: ${stats.skipNoTier} | Retry kuyruğu: ${retryQueue.size}`,
      `📦 Seri sayımı: ${seriesScan.status}`,
      ...seriesSummary(),
      channelIdHint(msg.chat.id),
    ].filter(l => l !== null);
    await bot.sendMessage(msg.chat.id, lines.join('\n'), { parse_mode: 'HTML' });
  });

  bot.onText(/\/sc1/, (msg) => bot.sendMessage(msg.chat.id, buildTierMsg(1), { parse_mode: 'HTML' }).catch(console.error));
  bot.onText(/\/sc2/, (msg) => bot.sendMessage(msg.chat.id, buildTierMsg(2), { parse_mode: 'HTML' }).catch(console.error));
  bot.onText(/\/sc3/, (msg) => bot.sendMessage(msg.chat.id, buildTierMsg(3), { parse_mode: 'HTML' }).catch(console.error));

  bot.onText(/\/kontrat/, async (msg) => {
    const chatId = msg.chat.id;
    await registerChat(chatId);
    await bot.sendMessage(chatId, '🔎 Kontratlar okunuyor (30-60 sn sürebilir)...');
    try {
      for (const part of chunkText(await probeContracts())) await bot.sendMessage(chatId, part);
    } catch (e) {
      await bot.sendMessage(chatId, `❌ Kontrat keşfi hatası: ${e.message}`);
    }
  });

  bot.onText(/\/diag (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    await registerChat(chatId);
    const txHash = match[1].trim();
    await bot.sendMessage(chatId, `🔍 Analiz ediliyor...`);
    const report = await diagnoseTx(txHash);
    await bot.sendMessage(chatId, report, { parse_mode: 'HTML', disable_web_page_preview: true });
  });

  bot.on('polling_error', (e) => {
    if (e.message?.includes('409')) {
      pollingErrCount++;
      // Another getUpdates consumer holds this token (an overlapping Railway
      // deploy, or someone using a leaked token). That only blocks incoming
      // commands — sendMessage keeps working — so never exit here: exiting
      // crash-looped the service into Railway's restart limit and stopped
      // every notification along with it.
      if (pollingErrCount === 1 || pollingErrCount % 50 === 0)
        console.error(`[TG] 409 Conflict ×${pollingErrCount} — aynı token ile başka bir instance çalışıyor. Bildirimler etkilenmez; komutlar için eski deploy'u durdurun veya token'ı BotFather'dan yenileyin.`);
    } else {
      pollingErrCount = 0;
      console.error('[TG polling]', e.message);
    }
  });

  console.log(`[${VERSION}] başladı | chat=${registeredChats.size} | state=${STATE_FILE}`);
  if (registeredChats.size === 0)
    console.log(`[UYARI] Kayıtlı chat yok — bildirimler kuyruğa alınacak. /start gönderin ve TELEGRAM_CHANNEL_ID ayarlayın.`);

  // Start WebSocket subscription for real-time events (poll loop is backup)
  startWsSubscription().catch(() => {});
  // Count sold cards per series from chain history in the background.
  scanSeriesHistory().catch(e => {
    seriesScan.status = `hata: ${(e.message || '').slice(0, 80)}`;
    console.error('[SERİ] tarama hatası:', e.message);
  });

  lastPollBlock = 0;
  await pollLoop();
}

main().catch(e => { console.error('[FATAL]', e); process.exit(1); });
