require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { ethers } = require('ethers');
const axios = require('axios');

const VERSION = 'v10.2';
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL_ID    = process.env.TELEGRAM_CHANNEL_ID || null;
const CONTRACT      = process.env.TOKEN_CONTRACT || '0xAe5F595803B2AA4D07aF8b392e535876a974a296';
const SC1_TARGET    = parseInt(process.env.SC1_TARGET || '200');
const SC2_TARGET    = parseInt(process.env.SC2_TARGET || '200');
const SC3_TARGET    = parseInt(process.env.SC3_TARGET || '200');
const COINGECKO_KEY = process.env.COINGECKO_API_KEY || '';

if (!TELEGRAM_TOKEN) { console.error('TELEGRAM_BOT_TOKEN eksik!'); process.exit(1); }

const CONTRACT_LOWER = CONTRACT.toLowerCase();
const ZERO_ADDRESS   = '0x0000000000000000000000000000000000000000';
const USDC_LOWER     = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

const BOT_START_TS    = Math.floor(Date.now() / 1000);
const LIVE_WINDOW_SEC = 300;

const registeredChats = new Set();
if (CHANNEL_ID) registeredChats.add(String(CHANNEL_ID));

const RPCS = [
  'https://mainnet.base.org',
  'https://base-rpc.publicnode.com',
  process.env.RPC_URL_1,
  process.env.RPC_URL_2,
  'https://base.gateway.tenderly.co',
  'https://1rpc.io/base',
  'https://base.blockscout.com/api/eth-rpc',
].filter(Boolean);

// v10.0: 3 tiers, all $1 USDC. Tier encoded in coordinator BUY event topics.
const TIER_INFO = {
  1: { name: 'mavi',  emoji: '🔵', payUsd: 1, target: SC1_TARGET },
  2: { name: 'yeşil', emoji: '🟢', payUsd: 1, target: SC2_TARGET },
  3: { name: 'mor',   emoji: '🟣', payUsd: 1, target: SC3_TARGET },
};
const PER_TOKEN_MAX_USD = 100;

const TRANSFER_TOPIC    = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
// Coordinator event sig prefixes (first 8 bytes of topic[0])
const BUY_EVENT_PREFIX   = '0x22e804d3';
const CLAIM_EVENT_PREFIX = '0xd7fd12e8';
// NFT contract custom event seen in logs (0x73c1e6085df115c7...)
const NFT_CUSTOM_PREFIX  = '0x73c1e608';

const CHAINLINK_ETHUSD = '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70';
const WETH             = '0x4200000000000000000000000000000000000006';
const USDC             = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const UNI_FACTORY      = '0x33128a8fC17869897dcE68Ed026d694621f6FDfD';
const AERO_FACTORY     = '0x420DD381b31aEf6683db6B902084cB0FFECe40Da';
const WETH_LOWER       = WETH.toLowerCase();

const tierStates = {};
function ts(tier) {
  if (!tierStates[tier])
    tierStates[tier] = { history: [], count: 0, sessionCount: 0, streak: 0, streakDir: null };
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
    return pairs[0].price;
  } catch (_) { return null; }
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

// v10.1: tier is param[1] in BUY function calldata.
// Function: buy(uint64 batchId, uint8 tier, uint256 seed, uint256 nonce, uint256 deadline)
// Selector : 0x3e29984c
// param[0] batchId → data[10:74]
// param[1] tier    → data[74:138]   ← 1=mavi 2=yeşil 3=mor
function tierFromCalldata(data) {
  if (!data || data.length < 138) return null;
  try {
    const val = Number(BigInt('0x' + data.slice(74, 138)));
    if (val >= 1 && val <= 3) return val;
  } catch (_) {}
  return null;
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
      console.log(`[BS instances] 404 — disabled for session`);
    }
  }
  return null;
}

let _logsProvider     = null;
let _logsProviderTried = false;
async function getLogsProvider() {
  if (_logsProvider) return _logsProvider;
  if (_logsProviderTried) return null;
  _logsProviderTried = true;
  try {
    const p = new ethers.JsonRpcProvider('https://base.blockscout.com/api/eth-rpc');
    await Promise.race([
      p.getBlockNumber(),
      new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 5000)),
    ]);
    _logsProvider = p;
    console.log('[logsRPC ✓] base.blockscout.com/api/eth-rpc');
    return p;
  } catch (e) {
    console.log(`[logsRPC ✗] ${(e.message || '').slice(0, 80)}`);
    return null;
  }
}

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
      if (logs.length) {
        console.log(`[${rpcLabel} hit] mint @ block=${logs[0].blockNumber} after ${chunksTried} chunks`);
        return logs[0].transactionHash;
      }
    } catch (e) {
      chunksFailed++;
      if (chunksFailed === 1) console.log(`[${rpcLabel} err] ${(e.message || '').slice(0, 80)}`);
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
  const queryAddr     = _nftContractAddr;
  const lp = await getLogsProvider();
  if (lp) {
    try {
      const latest = await lp.getBlockNumber();
      const logs = await lp.getLogs({
        address: queryAddr,
        topics: [TRANSFER_TOPIC, fromZeroTopic, null, tokenIdHex],
        fromBlock: Math.max(0, latest - 1_500_000),
        toBlock: latest,
      });
      if (logs.length) return logs[0].transactionHash;
    } catch (_) {}
  }
  try {
    const latest = await provider.getBlockNumber();
    return await _scanLogsForMint('mainRPC', provider, queryAddr, tokenIdHex, fromZeroTopic, latest, 200_000, 9999, 250);
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
  if (nftToTier.has(nftId)) {
    const info = nftToTier.get(nftId);
    console.log(`[RECOVER cache] nft=${nftId} tier=${info.tier} (${TIER_INFO[info.tier]?.name})`);
    return info.tier;
  }
  try {
    const found = await findMintTxHash(nftId);
    if (!found) { console.log(`[RECOVER fail] nft=${nftId}: mint TX bulunamadı`); return null; }
    const { hash: buyTxHash, src: lookupSrc } = found;
    const [buyTx, buyReceipt] = await Promise.all([
      provider.getTransaction(buyTxHash).catch(() => null),
      provider.getTransactionReceipt(buyTxHash).catch(() => null),
    ]);
    if (!buyReceipt) { console.log(`[RECOVER fail] nft=${nftId}: receipt yok`); return null; }
    const allMints = findAllNftMints(buyReceipt);
    const tier = tierFromCalldata(buyTx?.data || '') ?? findBuyTierFromLogs(buyReceipt, allMints.map(m => m.nftId));
    if (tier) {
      const block = await provider.getBlock(buyReceipt.blockNumber).catch(() => null);
      for (const m of allMints) {
        nftToTier.set(m.nftId, { tier, buyer: m.to, buyTxHash, buyTs: block?.timestamp || 0 });
      }
      console.log(`[RECOVER ${lookupSrc}] nft=${nftId} tier=${tier} (${TIER_INFO[tier]?.name}) from ${buyTxHash.slice(0,10)}`);
    } else {
      console.log(`[RECOVER no-tier] nft=${nftId}: BUY TX'te tier bilgisi yok ${buyTxHash.slice(0,10)}`);
    }
    return tier;
  } catch (e) {
    console.log(`[RECOVER fail] nft=${nftId}: ${(e.message || '').slice(0, 80)}`);
    return null;
  }
}

async function ensureRecentTiers() {
  if (_recentTiersPromise) return _recentTiersPromise;
  if (!_nftContractAddr) return;
  _recentTiersPromise = (async () => {
    try {
      const lp = await getLogsProvider();
      const useLp = lp || provider;
      const latest = await useLp.getBlockNumber();
      const fromBlock = Math.max(0, latest - 9000);
      const fromZeroTopic = '0x' + '0'.repeat(64);
      const allHashes = new Set();

      const tryGetLogs = async (rpc, params, label) => {
        try {
          const logs = await rpc.getLogs(params);
          for (const l of logs) allHashes.add(l.transactionHash);
          return logs.length;
        } catch (e) {
          console.log(`[ensureRecentTiers ${label}] ${(e.message || '').slice(0, 70)}`);
          return -1;
        }
      };

      const [n1, n2] = await Promise.all([
        tryGetLogs(useLp, { address: _nftContractAddr, topics: [TRANSFER_TOPIC, fromZeroTopic], fromBlock, toBlock: latest }, 'bs-mint'),
        tryGetLogs(useLp, { address: CONTRACT_LOWER, fromBlock, toBlock: latest }, 'bs-coord'),
      ]);
      if (useLp !== provider && (n1 <= 0 || n2 <= 0)) {
        await Promise.all([
          n1 <= 0 ? tryGetLogs(provider, { address: _nftContractAddr, topics: [TRANSFER_TOPIC, fromZeroTopic], fromBlock, toBlock: latest }, 'main-mint') : null,
          n2 <= 0 ? tryGetLogs(provider, { address: CONTRACT_LOWER, fromBlock, toBlock: latest }, 'main-coord') : null,
        ].filter(Boolean));
      }

      console.log(`[ensureRecentTiers] ${allHashes.size} TX adayı (bs mint=${n1} coord=${n2})`);
      let registered = 0;
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
          for (const m of mints) {
            if (!nftToTier.has(m.nftId)) {
              nftToTier.set(m.nftId, { tier, buyer: m.to, buyTxHash: hash, buyTs: block?.timestamp || 0 });
              registered++;
            }
          }
        } catch (_) {}
      }
      console.log(`[ensureRecentTiers] tamamlandı — ${registered} yeni tier | map=${nftToTier.size}`);
    } catch (e) {
      console.log(`[ensureRecentTiers] hata: ${(e.message || '').slice(0, 80)}`);
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

async function calcTotalUsd(received, sources) {
  let totalUsd = 0;
  const tokenSummary = [];
  const tokenDetail  = [];
  const droppedSummary = [];

  const addPriced = (addr, info, human, price, label) => {
    const usd = human * price;
    if (usd < 0.0001) return;
    if (usd > PER_TOKEN_MAX_USD) { droppedSummary.push(`${info.symbol}=$${usd.toFixed(2)}(OUTLIER)`); return; }
    const psrc = priceCache[addr.toLowerCase()]?.src || '?';
    const fsrc = sources && sources[addr] ? Array.from(sources[addr]).sort().join('') : '?';
    totalUsd += usd;
    tokenSummary.push(`${info.symbol}=$${usd.toFixed(4)}`);
    tokenDetail.push(`${info.symbol}[${fsrc}] ${human.toFixed(6)} @ $${price.toFixed(8)}[${psrc}${label}] = $${usd.toFixed(4)}`);
  };

  const pending = [];
  for (const [addr, rawAmt] of Object.entries(received)) {
    try {
      const info  = await getTokenInfo(addr);
      const human = Number(ethers.formatUnits(rawAmt, info.decimals));
      const price = await getTokenPriceUsd(addr);
      if (!price) { pending.push({ addr, info, human }); continue; }
      addPriced(addr, info, human, price, '');
    } catch (_) {}
  }

  if (pending.length) {
    await new Promise(r => setTimeout(r, 2000));
    for (const { addr, info, human } of pending) {
      try {
        delete priceCache[addr.toLowerCase()];
        const price = await getTokenPriceUsd(addr);
        if (!price) { droppedSummary.push(`${info.symbol}=NO_PRICE`); continue; }
        addPriced(addr, info, human, price, '*retry');
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
  try { receipt = await provider.getTransactionReceipt(txHash); } catch (e) {
    if (!isLoadingHistory || isRecentTx)
      console.log(`[SKIP rpc-err] ${txHash.slice(0,10)}: ${e.message.slice(0,60)}`);
    return;
  }
  if (!receipt || receipt.status === 0) return;

  rememberNftContract(receipt);

  // v10.1: BUY TX — detect tier from calldata param[1] (primary), then
  // fall back to coordinator/NFT event topics if calldata unavailable.
  const allMints = findAllNftMints(receipt);
  if (allMints.length) {
    const mintedIds = allMints.map(m => m.nftId);
    const tier = tierFromCalldata(data) ?? findBuyTierFromLogs(receipt, mintedIds);
    if (tier) {
      for (const m of allMints) {
        nftToTier.set(m.nftId, { tier, buyer: m.to, buyTxHash: txHash, buyTs: blockTs });
      }
      if (!isLoadingHistory || isRecentTx)
        console.log(`[BUY] tier=${tier}(${TIER_INFO[tier]?.name}) mints=${allMints.length} ids=[${mintedIds.join(',')}] | ${txHash.slice(0,10)}`);
    } else {
      if (!isLoadingHistory || isRecentTx)
        console.log(`[BUY ?] tier bilinmiyor mints=${allMints.length} ids=[${mintedIds.join(',')}] | ${txHash.slice(0,10)}`);
    }
    return; // BUY TX — no notification
  }

  // CLAIM TX
  const burn = findNftBurn(receipt);
  const claimer = burn ? burn.from.toLowerCase() : from.toLowerCase();

  const { received, src, sources } = collectReceived(receipt, claimer);
  if (!Object.keys(received).length) return;

  let claimedNftId = burn?.nftId ?? nftIdFromCalldata(data);

  let tier = null;
  if (claimedNftId && nftToTier.has(claimedNftId)) {
    tier = nftToTier.get(claimedNftId).tier;
  }

  const { totalUsd, tokenSummary, tokenDetail, droppedSummary } = await calcTotalUsd(received, sources);
  if (totalUsd <= 0) {
    if (!isLoadingHistory || isRecentTx)
      console.log(`[SKIP no-value] nft=${claimedNftId} dropped=[${droppedSummary.join(' ')}] | ${txHash.slice(0,10)}`);
    return;
  }

  if (tier === null && claimedNftId && (!isLoadingHistory || isRecentTx)) {
    tier = await recoverTierFromBuyTx(claimedNftId);
  }

  // v10.0: silently skip if tier can't be determined (not a $1 scratch card)
  if (tier === null) return;

  const tierInfo  = TIER_INFO[tier];
  const cycleSize = tierInfo.target;
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

  // Show avg(5,10,15,20,25,50,100,200) for all 3 tiers on every notification
  const AVG_NS = [5, 10, 15, 20, 25, 50, 100, 200];
  const allAvgLines = [1, 2, 3].map(t => {
    const tState = ts(t);
    const tInfo  = TIER_INFO[t];
    const avgs = AVG_NS
      .map(n => { const v = calcAvg(tState.history, n); return v !== null ? `Avg${n}:$${v.toFixed(2)}` : null; })
      .filter(Boolean).join(' | ');
    return avgs ? `${tInfo.emoji} ${avgs}` : null;
  }).filter(Boolean).join('\n');

  const msg = [
    `${tierInfo.emoji} Total Value: $${totalUsd.toFixed(2)} [${tierInfo.name}]`,
    `📍 Döngü: ${posInCycle}/${cycleSize} (~${remaining} kaldı) — Döngü Avg: $${cycleAvg.toFixed(2)}`,
    `🔴 Streak: ${state.streak}`,
    allAvgLines || null,
    `👤 ${claimer}`,
    `🕐 ${date} | <a href="${txUrl}">TX</a>`,
  ].filter(Boolean).join('\n');

  console.log(`[✓] ${tierInfo.name} won=$${totalUsd.toFixed(2)} nft=${claimedNftId} cyc=${posInCycle}/${cycleSize} | ${tokenDetail.join(' || ')} | ${txHash.slice(0,10)}`);
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
      const { totalUsd, tokenDetail, droppedSummary } = await calcTotalUsd(received, sources);
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
  const lp = await getLogsProvider();
  const allHashes = new Set();
  let bsGotResults = false;
  if (lp) {
    try {
      const logs = await lp.getLogs({ address: _nftContractAddr, topics: [TRANSFER_TOPIC, fromZeroTopic], fromBlock: from, toBlock: to });
      for (const l of logs) allHashes.add(l.transactionHash);
      if (logs.length > 0) bsGotResults = true;
    } catch (_) {}
  }
  if (!bsGotResults) {
    const logs = await provider.getLogs({ address: _nftContractAddr, topics: [TRANSFER_TOPIC, fromZeroTopic], fromBlock: from, toBlock: to });
    for (const l of logs) allHashes.add(l.transactionHash);
  }
  return [...allHashes];
}

async function scanCoordinatorLogs(from, to) {
  const lp = await getLogsProvider();
  const allHashes = new Set();
  let bsGotResults = false;
  if (lp) {
    try {
      const logs = await lp.getLogs({ address: CONTRACT_LOWER, fromBlock: from, toBlock: to });
      for (const l of logs) allHashes.add(l.transactionHash);
      if (logs.length > 0) bsGotResults = true;
    } catch (_) {}
  }
  if (!bsGotResults) {
    const logs = await provider.getLogs({ address: CONTRACT_LOWER, fromBlock: from, toBlock: to });
    for (const l of logs) allHashes.add(l.transactionHash);
  }
  return [...allHashes];
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
      await new Promise(r => setTimeout(r, 2500));
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
  const cycleSize = tierInfo.target;
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
    `  • 🔵 mavi: Kaç tane açıldı? (?/200)`,
    `  • 🟢 yeşil: Kaç tane açıldı? (?/200)`,
    `  • 🟣 mor: Kaç tane açıldı? (?/200)`,
    '',
    '💬 Sırayla cevapla',
  ];
  await bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML' });
  conversations[chatId] = { step: 0, data: {} };
  const first = TIER_INFO[TIERS_ORDER[0]];
  await bot.sendMessage(chatId, `${first.emoji} ${first.name}: Kaç tane açıldı? (?/${first.target})`);
}

async function handleConversationReply(chatId, text) {
  const conv = conversations[chatId];
  if (!conv) return;
  const n = parseInt(text.trim(), 10);
  if (isNaN(n) || n < 0 || n > 50000) {
    await bot.sendMessage(chatId, '❌ Geçerli bir sayı girin (örn: 45)');
    return;
  }
  const tierNum = TIERS_ORDER[conv.step];
  conv.data[tierNum] = n;
  conv.step++;
  if (conv.step < TIERS_ORDER.length) {
    const next = TIER_INFO[TIERS_ORDER[conv.step]];
    await bot.sendMessage(chatId, `${next.emoji} ${next.name}: Kaç tane açıldı? (?/${next.target})`);
  } else {
    delete conversations[chatId];
    for (const t of TIERS_ORDER)
      if (conv.data[t] !== undefined) ts(t).sessionCount = conv.data[t];
    const lines = ['✅ Döngü Sayıcıları Ayarlandı:'];
    for (const t of TIERS_ORDER) {
      const info = TIER_INFO[t];
      const avg  = overallAvg(t);
      lines.push(`  • ${info.emoji} ${info.name}: ${ts(t).sessionCount}/${info.target} (ort: ${avg !== null ? '$'+avg.toFixed(2) : 'N/A'})`);
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
      `🔵 mavi (${SC1_TARGET}): ${ts(1).sessionCount}`,
      `🟢 yeşil (${SC2_TARGET}): ${ts(2).sessionCount}`,
      `🟣 mor (${SC3_TARGET}): ${ts(3).sessionCount}`,
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

  console.log(`[${VERSION}] Contract: ${CONTRACT}`);
  console.log(`[${VERSION}] mavi(1)=${SC1_TARGET} yeşil(2)=${SC2_TARGET} mor(3)=${SC3_TARGET}`);
  console.log(`[${VERSION}] BOT_START_TS=${BOT_START_TS} CG_KEY=${COINGECKO_KEY ? 'yes' : 'no'}`);
  console.log(`[${VERSION}] Kayıtlı chat: ${registeredChats.size} | CHANNEL_ID=${CHANNEL_ID || 'YOK — /track ile ekleyin'}`);
  if (registeredChats.size === 0) console.log(`[UYARI] Hiç kayıtlı chat yok! /track veya /test gönderin.`);

  lastPollBlock = 0;
  await pollLoop();
}

main().catch(e => { console.error('[FATAL]', e); process.exit(1); });
