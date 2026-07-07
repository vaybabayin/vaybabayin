require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { ethers } = require('ethers');
const axios = require('axios');

const VERSION = 'v11.6';
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL_ID    = process.env.TELEGRAM_CHANNEL_ID || null;
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

const registeredChats = new Set();
if (CHANNEL_ID) registeredChats.add(String(CHANNEL_ID));

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

// Runtime-mutable cycle size for mor (tier 3). Overridden via /start.
let sc3CycleOverride = SC3_TARGET;
function getCycleSize(tier) { return tier === 3 ? sc3CycleOverride : TIER_INFO[tier].target; }

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
    tierStates[tier] = { history: [], count: 0, sessionCount: 0, streak: 0, streakDir: null, jackpotCycleCount: 0 };
  return tierStates[tier];
}

const nftToTier = new Map();
const conversations = {};
let processedTxs = new Set();
let pollingErrCount = 0;
let provider, bot;
let tokenInfoCache = {};
let priceCache = {};
let ethPrice = 0, ethPriceAt = 0;
let lastPollBlock = 0;
let isLoadingHistory = false;
let _recentTiersPromise = null;
let _nftContractAddr = (process.env.NFT_CONTRACT || '').toLowerCase() || null;

// WebSocket subscription state
let wsProvider       = null;
let wsConnected      = false;
let wsReconnectTimer = null;

async function getProvider() {
  for (const rpc of RPCS) {
    try {
      const p = new ethers.JsonRpcProvider(rpc);
      await Promise.race([p.getBlockNumber(),
        new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 5000))]);
      console.log(`[RPC ✓] ${rpc}`);
      return p;
    } catch (e) { console.log(`[RPC ✗] ${e.message.slice(0, 70)}`); }
  }
  throw new Error('Hiçbir RPC bağlanamadı');
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

async function sendNotification(msg) {
  if (registeredChats.size === 0) {
    console.log('[NOTIFY] kayıtlı chat yok — bildirim gönderilemiyor. /track ile ekleyin.');
    return;
  }
  for (const chatId of registeredChats) {
    try {
      await bot.sendMessage(chatId, msg, { parse_mode: 'HTML', disable_web_page_preview: true });
    } catch (e) {
      console.error(`[TG HATA] chat=${chatId} | ${e.message}`);
      if (e.message?.includes('bot was blocked') || e.message?.includes('chat not found')) {
        registeredChats.delete(chatId);
      }
    }
  }
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
      return Number(tierVal);
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
  if (!data || data.length < 10) return null;
  const sel = data.slice(0, 10).toLowerCase();

  if (sel === EP_HANDLEOPS_SEL) {
    try {
      const [ops] = getEpIface().decodeFunctionData('handleOps', data);
      for (const op of ops) {
        const inner = op.callData ?? op[3];
        if (!inner || inner === '0x' || inner.length < 10) continue;
        const t = findTierByPattern(inner);
        if (t) return t;
      }
    } catch (_) {}
    // Decode failed (unknown UserOp layout) → universal raw scan below.
  }

  // Universal fallback: scan the full raw calldata for the triplet.
  return findTierByPattern(data);
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

let _bsInstancesDisabled = false;
async function findMintTxBlockscout(nftId) {
  if (_bsInstancesDisabled) return null;
  try {
    const addr = CONTRACT.toLowerCase();
    const url = `https://base.blockscout.com/api/v2/tokens/${addr}/instances/${nftId}/transfers`;
    const r = await axios.get(url, { timeout: 10000 });
    const items = r.data?.items || [];
    for (const t of items) {
      const fromHash = (t.from?.hash || t.from || '').toLowerCase();
      if (fromHash === ZERO_ADDRESS) return t.transaction_hash || t.tx_hash || t.hash || null;
    }
  } catch (e) {
    if (e.response?.status === 404 && !_bsInstancesDisabled) {
      _bsInstancesDisabled = true;
    }
  }
  return null;
}

// Alchemy is already the main provider — use it for logs too.
function getLogsProvider() { return provider; }

async function _scanLogsForMint(rpcLabel, lp, queryAddr, tokenIdHex, fromZeroTopic, latest, maxLookback, chunk, delayMs) {
  let chunksTried = 0, chunksFailed = 0;
  for (let offset = 0; offset < maxLookback; offset += chunk) {
    const toBlock   = latest - offset;
    const fromBlock = Math.max(0, toBlock - chunk + 1);
    if (toBlock < fromBlock) break;
    chunksTried++;
    try {
      const logs = await lp.getLogs({
        address: queryAddr,
        topics: [TRANSFER_TOPIC, fromZeroTopic, null, tokenIdHex],
        fromBlock, toBlock,
      });
      if (logs.length) return logs[0].transactionHash;
    } catch (e) {
      chunksFailed++;
    }
    if (fromBlock === 0) break;
    if (delayMs) await new Promise(r => setTimeout(r, delayMs));
  }
  return null;
}

async function findMintTxOnchain(nftId) {
  if (!_nftContractAddr) return null;
  const tokenIdHex    = '0x' + BigInt(nftId).toString(16).padStart(64, '0');
  const fromZeroTopic = '0x' + '0'.repeat(64);
  try {
    const latest = await provider.getBlockNumber();
    // Try wide-range query first (Alchemy allows larger ranges)
    try {
      const logs = await provider.getLogs({
        address: _nftContractAddr,
        topics: [TRANSFER_TOPIC, fromZeroTopic, null, tokenIdHex],
        fromBlock: Math.max(0, latest - 1_500_000),
        toBlock: latest,
      });
      if (logs.length) return logs[0].transactionHash;
    } catch (_) {}
    // Fallback: chunked scan
    return await _scanLogsForMint('mainRPC', provider, _nftContractAddr, tokenIdHex, fromZeroTopic, latest, 200_000, 9999, 250);
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
  await ensureRecentTiers();
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
      const allHashes = new Set();

      const gatherLogs = async (params) => {
        try {
          const logs = await provider.getLogs(params);
          for (const l of logs) allHashes.add(l.transactionHash);
        } catch (_) {}
      };

      await Promise.all([
        gatherLogs({ address: _nftContractAddr, topics: [TRANSFER_TOPIC, fromZeroTopic], fromBlock, toBlock: latest }),
        gatherLogs({ address: CONTRACT_LOWER, fromBlock, toBlock: latest }),
      ]);

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
      _recentTiersPromise = null;
      throw e;
    }
  })();
  try { await _recentTiersPromise; } catch (_) {}
  return _recentTiersPromise;
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

async function processTx(txHash, from, data, blockNum, blockTs) {
  if (processedTxs.has(txHash)) return;
  processedTxs.add(txHash);
  if (processedTxs.size > 20000) {
    const arr = [...processedTxs]; processedTxs = new Set(arr.slice(-10000));
  }

  const isRecentTx = blockTs >= BOT_START_TS - LIVE_WINDOW_SEC;

  let receipt;
  try { receipt = await provider.getTransactionReceipt(txHash); } catch (e) { return; }
  if (!receipt || receipt.status === 0) return;

  rememberNftContract(receipt);

  // BUY TX — detect tier from calldata (all param slots) or event topics.
  // Silently register; no notification, no routine log.
  const allMints = findAllNftMints(receipt);
  if (allMints.length) {
    const mintedIds = allMints.map(m => m.nftId);
    const tier = tierFromCalldata(data) ?? findBuyTierFromLogs(receipt, mintedIds);
    if (tier) {
      const paid = findUsdcPayment(receipt, allMints[0].to);
      for (const m of allMints) {
        nftToTier.set(m.nftId, { tier, buyer: m.to, buyTxHash: txHash, buyTs: blockTs, paid });
      }
    } else if (!isLoadingHistory || isRecentTx) {
      // Unknown tier on a real mint signals a contract/format change — keep.
      console.log(`[BUY?] tier yok sel=${data?.slice(0,10)} ids=[${mintedIds.join(',')}] | ${txHash.slice(0,10)}`);
    }
    return;
  }

  // CLAIM TX
  const burn = findNftBurn(receipt);
  const claimer = burn ? burn.from.toLowerCase() : from.toLowerCase();

  const { received, sources } = collectReceived(receipt, claimer);
  if (!Object.keys(received).length) return;

  let claimedNftId = burn?.nftId ?? nftIdFromCalldata(data);

  let entry = claimedNftId ? nftToTier.get(claimedNftId) : null;
  let tier = entry?.tier ?? null;

  const { totalUsd } = await calcTotalUsd(received, sources, perTokenCapUsd(tier));
  if (totalUsd <= 0) return;

  if (tier === null && claimedNftId && (!isLoadingHistory || isRecentTx)) {
    tier = await recoverTierFromBuyTx(claimedNftId);
    entry = claimedNftId ? nftToTier.get(claimedNftId) : null; // re-read after recovery
  }

  // Skip free packages — only notify for cards bought with ~1 USDC.
  if (entry && typeof entry.paid === 'number' && entry.paid < MIN_PAID_USDC) return;

  if (tier === null) return;

  const tierInfo  = TIER_INFO[tier];
  const cycleSize = getCycleSize(tier);
  const state = ts(tier);

  if (state.history.length > 0) {
    const dir = totalUsd >= state.history[0].usd ? 'up' : 'down';
    state.streak    = dir === state.streakDir ? state.streak + 1 : 1;
    state.streakDir = dir;
  } else {
    state.streak = 1; state.streakDir = null;
  }

  state.count++;
  if (!isLoadingHistory || isRecentTx) state.sessionCount++;
  state.history.unshift({ usd: totalUsd, ts: blockTs * 1000, hash: txHash, claimer: from });
  if (state.history.length > Math.max(cycleSize, 200)) state.history.pop();

  if (isLoadingHistory && !isRecentTx) return;

  const pos        = state.sessionCount > 0 ? state.sessionCount : state.count;
  const posInCycle = ((pos - 1) % cycleSize) + 1;
  const remaining  = cycleSize - posInCycle;
  const date       = new Date(blockTs * 1000).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
  const txUrl      = `https://basescan.org/tx/${txHash}`;
  const cycleSlice = state.history.slice(0, posInCycle);
  const cycleAvg   = cycleSlice.reduce((s, c) => s + c.usd, 0) / (cycleSlice.length || 1);

  // Jackpot detection: totalUsd within the tier's fixed band (v11.5).
  //   mavi $4–8 · yeşil $7–15 · mor $15–30 (inclusive).
  // Reset per-cycle counter when a new cycle begins (posInCycle wraps to 1).
  const { jackpotMin, jackpotMax, jackpotTotal } = tierInfo;
  const isJackpot = totalUsd >= jackpotMin && totalUsd <= jackpotMax;
  if (posInCycle === 1 && pos > 1) state.jackpotCycleCount = 0; // new cycle
  if (isJackpot) state.jackpotCycleCount++;

  // Avg for this tier only
  const avgLine = [5, 10, 15, 20, 25, 50, 100, 200]
    .map(n => { const v = calcAvg(state.history, n); return v !== null ? `Avg${n}:$${v.toFixed(2)}` : null; })
    .filter(Boolean).join(' | ');

  const msg = [
    `${tierInfo.emoji} Total Value: $${totalUsd.toFixed(2)} [${tierInfo.name}]`,
    `📍 Döngü: ${posInCycle}/${cycleSize} (~${remaining} kaldı) — Döngü Avg: $${cycleAvg.toFixed(2)}`,
    `🔴 Streak: ${state.streak}`,
    `🎰 Jackpot: ${state.jackpotCycleCount}/${jackpotTotal}${isJackpot ? ' 🎉 JACKPOT!' : ''}`,
    avgLine ? `📊 ${avgLine}` : null,
    `👤 ${claimer}`,
    `🕐 ${date} | <a href="${txUrl}">TX</a>`,
  ].filter(Boolean).join('\n');

  console.log(`[✓] ${tierInfo.name} $${totalUsd.toFixed(2)} ${posInCycle}/${cycleSize} #${claimedNftId}`);
  await sendNotification(msg);
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

async function scanMintLogs(from, to) {
  if (!_nftContractAddr) return [];
  const fromZeroTopic = '0x' + '0'.repeat(64);
  try {
    const logs = await provider.getLogs({ address: _nftContractAddr, topics: [TRANSFER_TOPIC, fromZeroTopic], fromBlock: from, toBlock: to });
    return [...new Set(logs.map(l => l.transactionHash))];
  } catch (_) { return []; }
}

async function scanCoordinatorLogs(from, to) {
  try {
    const logs = await provider.getLogs({ address: CONTRACT_LOWER, fromBlock: from, toBlock: to });
    return [...new Set(logs.map(l => l.transactionHash))];
  } catch (_) { return []; }
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
  if (!txHash || processedTxs.has(txHash)) return;
  try {
    const bundle = await fetchTxBundle(txHash);
    if (!bundle) return;
    await processTx(txHash, bundle.tx.from, bundle.tx.data || '', bundle.receipt.blockNumber, bundle.block?.timestamp || 0);
  } catch (e) {
    console.error(`[WS] ${txHash.slice(0,10)}: ${e.message?.slice(0,80)}`);
  }
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

async function pollLoop() {
  let fails = 0;
  console.log('[POLL] Canlı izleme başlıyor...');
  while (true) {
    try {
      const cur = await provider.getBlockNumber();
      if (lastPollBlock === 0) lastPollBlock = cur - 1;
      if (cur > lastPollBlock) {
        const from = lastPollBlock + 1;
        const to   = Math.min(cur, lastPollBlock + 20);

        const coordTxs = await scanCoordinatorLogs(from, to);
        for (const hash of coordTxs) {
          if (processedTxs.has(hash)) continue;
          const bundle = await fetchTxBundle(hash);
          if (!bundle) { console.log(`[POLL miss] ${hash.slice(0,10)} fetch failed`); continue; }
          try {
            await processTx(hash, bundle.tx.from, bundle.tx.data || '', bundle.receipt.blockNumber, bundle.block?.timestamp || 0);
          } catch (e) {
            console.error(`[POLL processTx] ${hash.slice(0,10)}: ${e.message?.slice(0,80)}`);
          }
        }

        const mintTxs = await scanMintLogs(from, to);
        for (const hash of mintTxs) {
          if (processedTxs.has(hash)) continue;
          const bundle = await fetchTxBundle(hash);
          if (!bundle) { console.log(`[POLL miss] ${hash.slice(0,10)} (mint) fetch failed`); continue; }
          try {
            await processTx(hash, bundle.tx.from, bundle.tx.data || '', bundle.receipt.blockNumber, bundle.block?.timestamp || 0);
          } catch (e) {
            console.error(`[POLL processTx mint] ${hash.slice(0,10)}: ${e.message?.slice(0,80)}`);
          }
        }

        lastPollBlock = to;
      }
      fails = 0;
      // When WS is live it handles real-time events; poll is just gap-filler backup.
      await new Promise(r => setTimeout(r, wsConnected ? 6000 : 2500));
    } catch (e) {
      fails++;
      console.error('[POLL]', e.message.slice(0, 80));
      if (fails >= 5) { try { provider = await getProvider(); fails = 0; } catch (_) {} }
      await new Promise(r => setTimeout(r, Math.min(fails * 3000, 30000)));
    }
  }
}

function buildTierMsg(tierNum) {
  const state     = ts(tierNum);
  const tierInfo  = TIER_INFO[tierNum];
  const cycleSize = getCycleSize(tierNum);
  const pos       = state.sessionCount > 0 ? state.sessionCount : state.count;
  if (!pos) return `${tierInfo.emoji} Henüz ${tierInfo.name} kaydı yok.`;
  const posInCycle = ((pos - 1) % cycleSize) + 1;
  const cycleSlice = state.history.slice(0, posInCycle);
  const cycleAvg   = cycleSlice.reduce((s, c) => s + c.usd, 0) / (cycleSlice.length || 1);
  const sEmoji     = state.streakDir === 'down' ? '🔴' : '🟢';
  const avgLines   = [5, 10, 15, 20, 25, 50, 100, 200]
    .map(n => { const v = calcAvg(state.history, n); return v !== null ? `Avg${n}: $${v.toFixed(2)}` : null; })
    .filter(Boolean).join('\n');
  return [
    `${tierInfo.emoji} <b>${tierInfo.name.toUpperCase()} İstatistikleri</b> ${VERSION}`,
    `($${tierInfo.payUsd} USDC paket)`,
    '',
    `Toplam: ${pos}/${cycleSize}`,
    `📍 Döngü: ${posInCycle}/${cycleSize} — Avg: $${cycleAvg.toFixed(2)}`,
    `${sEmoji} Streak: ${state.streak}`,
    '',
    avgLines || 'Yetersiz veri',
  ].join('\n');
}

const TIERS_ORDER = [1, 2, 3];

async function startConversation(chatId) {
  const isNew = !registeredChats.has(String(chatId));
  registeredChats.add(String(chatId));
  if (isNew) console.log(`[TG] Yeni chat: ${chatId} (toplam: ${registeredChats.size})`);

  const lines = [
    `👋 <b>Scratch Card Tracker</b> ${VERSION}`,
    '',
    '✅ Bu chat bildirim listesine eklendi.',
    '',
    '📊 Döngü Sayıcıları:',
    `  • 🔵 mavi: Kaç tane açıldı? (?/${SC1_TARGET})`,
    `  • 🟢 yeşil: Kaç tane açıldı? (?/${SC2_TARGET})`,
    `  • 🟣 mor: Seri kaç paketlik? + Kaç tane açıldı?`,
    '',
    '💬 Sırayla cevapla',
  ];
  await bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML' });
  conversations[chatId] = { step: 'tier1', data: {} };
  await bot.sendMessage(chatId, `🔵 mavi: Kaç tane açıldı? (?/${SC1_TARGET})`);
}

async function handleConversationReply(chatId, text) {
  const conv = conversations[chatId];
  if (!conv) return;
  const n = parseInt(text.trim(), 10);
  if (isNaN(n) || n < 0 || n > 50000) {
    await bot.sendMessage(chatId, '❌ Geçerli bir sayı girin (örn: 45)');
    return;
  }

  if (conv.step === 'tier1') {
    conv.data[1] = n;
    conv.step = 'tier2';
    await bot.sendMessage(chatId, `🟢 yeşil: Kaç tane açıldı? (?/${SC2_TARGET})`);
  } else if (conv.step === 'tier2') {
    conv.data[2] = n;
    conv.step = 'mor_size';
    await bot.sendMessage(chatId, `🟣 mor: Seri kaç paketlik? (varsayılan: ${sc3CycleOverride})`);
  } else if (conv.step === 'mor_size') {
    conv.data.sc3Size = n > 0 ? n : sc3CycleOverride;
    conv.step = 'mor_opened';
    await bot.sendMessage(chatId, `🟣 mor: Kaç tane açıldı? (?/${conv.data.sc3Size})`);
  } else if (conv.step === 'mor_opened') {
    conv.data[3] = n;
    delete conversations[chatId];

    ts(1).sessionCount = conv.data[1];
    ts(2).sessionCount = conv.data[2];
    sc3CycleOverride   = conv.data.sc3Size;
    ts(3).sessionCount = conv.data[3];

    const lines = ['✅ Döngü Sayıcıları Ayarlandı:'];
    for (const t of TIERS_ORDER) {
      const info = TIER_INFO[t];
      const size = getCycleSize(t);
      const avg  = overallAvg(t);
      lines.push(`  • ${info.emoji} ${info.name}: ${ts(t).sessionCount}/${size} (ort: ${avg !== null ? '$'+avg.toFixed(2) : 'N/A'})`);
    }
    lines.push('', '💡 Yeni paket gelince sayıç otomatik ilerleyecek.');
    await bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML' });
  }
}

async function main() {
  provider = await getProvider();
  bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

  bot.onText(/\/start/, (msg) => startConversation(msg.chat.id).catch(console.error));

  bot.onText(/\/track/, async (msg) => {
    registeredChats.add(String(msg.chat.id));
    console.log(`[TG] Chat kaydedildi: ${msg.chat.id}`);
    await bot.sendMessage(msg.chat.id, '✅ Bu chat bildirim listesine eklendi.');
  });

  bot.onText(/\/stop/, async (msg) => {
    registeredChats.delete(String(msg.chat.id));
    await bot.sendMessage(msg.chat.id, '🔕 Bildirim listesinden çıkarıldı.');
  });

  bot.onText(/\/komut/, async (msg) => {
    registeredChats.add(String(msg.chat.id));
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
      '/komut — Bu listeyi göster',
      '/diag &lt;TX_HASH&gt; — TX analizi',
    ];
    await bot.sendMessage(msg.chat.id, lines.join('\n'), { parse_mode: 'HTML' });
  });

  bot.onText(/\/test/, async (msg) => {
    registeredChats.add(String(msg.chat.id));
    const lines = [
      `✅ <b>Test</b> ${VERSION}`,
      `📡 Kayıtlı chat: ${registeredChats.size}`,
      `📇 NFT map: ${nftToTier.size}`,
      `🔌 WebSocket: ${wsConnected ? '✅ aktif' : '❌ bağlı değil'}`,
      `🔵 mavi (${SC1_TARGET}): ${ts(1).sessionCount}`,
      `🟢 yeşil (${SC2_TARGET}): ${ts(2).sessionCount}`,
      `🟣 mor (${sc3CycleOverride}): ${ts(3).sessionCount}`,
    ];
    await bot.sendMessage(msg.chat.id, lines.join('\n'), { parse_mode: 'HTML' });
  });

  bot.onText(/\/sc1/, (msg) => bot.sendMessage(msg.chat.id, buildTierMsg(1), { parse_mode: 'HTML' }).catch(console.error));
  bot.onText(/\/sc2/, (msg) => bot.sendMessage(msg.chat.id, buildTierMsg(2), { parse_mode: 'HTML' }).catch(console.error));
  bot.onText(/\/sc3/, (msg) => bot.sendMessage(msg.chat.id, buildTierMsg(3), { parse_mode: 'HTML' }).catch(console.error));

  bot.onText(/\/diag (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    registeredChats.add(String(chatId));
    const txHash = match[1].trim();
    await bot.sendMessage(chatId, `🔍 Analiz ediliyor...`);
    const report = await diagnoseTx(txHash);
    await bot.sendMessage(chatId, report, { parse_mode: 'HTML', disable_web_page_preview: true });
  });

  bot.on('message', (msg) => {
    const text = (msg.text || '').trim();
    if (text.startsWith('/')) return;
    if (!conversations[msg.chat.id]) return;
    handleConversationReply(msg.chat.id, text).catch(console.error);
  });

  bot.on('polling_error', (e) => {
    if (e.message?.includes('409')) {
      pollingErrCount++;
      console.error(`[TG] 409 Conflict #${pollingErrCount} — başka bir instance aktif! Railway'de eski deployment durdur.`);
      // Exit after 5 repeated 409s so Railway restarts cleanly
      if (pollingErrCount >= 5) {
        console.error('[TG] 409 limit aşıldı — process sonlandırılıyor.');
        process.exit(1);
      }
    } else {
      pollingErrCount = 0;
      console.error('[TG polling]', e.message);
    }
  });

  console.log(`[${VERSION}] başladı | mavi=${SC1_TARGET} yeşil=${SC2_TARGET} mor=${sc3CycleOverride} | chat=${registeredChats.size} | Alchemy+WS`);
  if (registeredChats.size === 0) console.log(`[UYARI] Kayıtlı chat yok — /track veya /test gönderin.`);

  // Start WebSocket subscription for real-time events (poll loop is backup)
  startWsSubscription().catch(() => {});

  lastPollBlock = 0;
  await pollLoop();
}

main().catch(e => { console.error('[FATAL]', e); process.exit(1); });
