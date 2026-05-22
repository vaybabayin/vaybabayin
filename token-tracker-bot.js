require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { ethers } = require('ethers');
const axios = require('axios');

const VERSION = 'v9.25';
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL_ID    = process.env.TELEGRAM_CHANNEL_ID || null;
const CONTRACT      = process.env.TOKEN_CONTRACT || '0xAe5F595803B2AA4D07aF8b392e535876a974a296';
const SC1_TARGET    = parseInt(process.env.SC1_TARGET || '200');
const SC5_TARGET    = parseInt(process.env.SC5_TARGET || '100');
const COINGECKO_KEY = process.env.COINGECKO_API_KEY || '';

if (!TELEGRAM_TOKEN) { console.error('TELEGRAM_BOT_TOKEN eksik!'); process.exit(1); }

const CONTRACT_LOWER = CONTRACT.toLowerCase();
const ZERO_ADDRESS   = '0x0000000000000000000000000000000000000000';
const USDC_LOWER     = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

// TXs timestamped within this many seconds of bot start are treated as
// "live" even when encountered during history loading, so they still fire
// a Telegram notification instead of being silently absorbed.
const BOT_START_TS    = Math.floor(Date.now() / 1000);
const LIVE_WINDOW_SEC = 300; // 5 minutes

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

const TIER_INFO = {
  1: { name: 'green',  emoji: '\u{1F7E2}', payUsd: 1, target: SC1_TARGET },
  2: { name: 'purple', emoji: '\u{1F7E3}', payUsd: 5, target: SC5_TARGET },
};
const PER_TOKEN_MAX_USD = 100;

const TRANSFER_TOPIC   = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
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

// CoinGecko Simple Price API on Base. Returns null on miss/error.
// Pro key (CG-...) auto-selects pro-api.coingecko.com.
// v9.20: always retry once after 1.5s when the first attempt returns null.
// Covers both 429 rate-limits AND the empty-200 bodies CoinGecko sometimes
// returns when polled too quickly.
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
    } catch (_) {
      return null;
    }
  };

  const first = await fetchOnce();
  if (first) return first;
  await new Promise(r => setTimeout(r, 1500));
  return await fetchOnce();
}

// DexScreener — pick highest-USD-liquidity Base pair (not just pairs[0]).
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
  } catch (_) {
    return null;
  }
}

// Uniswap V3 on Base — try every fee tier on USDC and WETH, pick the pool
// with the highest in-range liquidity (instead of "first found wins").
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

// Aerodrome V2 — pick deepest pool by reserves * price.
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
  } catch (_) {
    return null;
  }
}

async function getTokenPriceUsd(address) {
  const k = address.toLowerCase();
  const cached = priceCache[k];
  if (cached && Date.now() - cached.at < 60_000) return cached.price;
  const { decimals } = await getTokenInfo(address);

  // Source order (most reliable first):
  //   1. CoinGecko Simple Price (curated, deep-liquidity reference price)
  //   2. DexScreener best-liquidity Base pair (aggregator, USD-quoted)
  //   3. Uniswap V3 on-chain — pick deepest pool across all fee tiers
  //   4. Aerodrome V2 on-chain — pick deepest pool
  let price = null, src = null;
  price = await cgPrice(address);                          if (price) src = 'cg';
  if (!price) { price = await dsPrice(address);            if (price) src = 'ds'; }
  if (!price) { price = await uniPrice(address, decimals); if (price) src = 'uni'; }
  if (!price) { price = await aeroPrice(address, decimals); if (price) src = 'aero'; }

  if (price) {
    priceCache[k] = { price, at: Date.now(), src };
    return price;
  }
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
  if (registeredChats.size === 0) return;
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

function findNftMint(receipt) {
  for (const log of receipt.logs) {
    if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
    if (log.topics.length !== 4) continue;
    if (log.address.toLowerCase() !== CONTRACT_LOWER) continue;
    const f = ('0x' + log.topics[1].slice(26)).toLowerCase();
    if (f !== ZERO_ADDRESS) continue;
    const to = ('0x' + log.topics[2].slice(26)).toLowerCase();
    const nftId = BigInt(log.topics[3]).toString();
    return { nftId, to };
  }
  return null;
}

// v9.22: collect ALL mints in a single BUY TX (a buyer can mint multiple
// cards in one transaction). Used to compute per-card USDC price correctly.
function findAllNftMints(receipt) {
  const mints = [];
  for (const log of receipt.logs) {
    if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
    if (log.topics.length !== 4) continue;
    if (log.address.toLowerCase() !== CONTRACT_LOWER) continue;
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
    if (log.address.toLowerCase() !== CONTRACT_LOWER) continue;
    const to = ('0x' + log.topics[2].slice(26)).toLowerCase();
    if (to !== ZERO_ADDRESS) continue;
    const from = ('0x' + log.topics[1].slice(26)).toLowerCase();
    const nftId = BigInt(log.topics[3]).toString();
    return { nftId, from };
  }
  return null;
}

function findUsdcPayment(receipt, payer) {
  for (const log of receipt.logs) {
    if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
    if (log.topics.length < 3) continue;
    if (log.address.toLowerCase() !== USDC_LOWER) continue;
    const f = ('0x' + log.topics[1].slice(26)).toLowerCase();
    const t = ('0x' + log.topics[2].slice(26)).toLowerCase();
    if (f !== payer || t !== CONTRACT_LOWER) continue;
    if (!log.data || log.data === '0x') continue;
    return Number(BigInt(log.data)) / 1e6;
  }
  return 0;
}

function classifyByUsdc(usdAmount) {
  if (usdAmount >= 0.5 && usdAmount < 2.5) return 1;
  if (usdAmount >= 2.5 && usdAmount < 10) return 2;
  return null;
}

// v9.22: find the mint TX hash for an NFT — Blockscout first (fast),
// eth_getLogs fallback (slower but works when Blockscout doesn't index
// the token or the mint is outside the default page).
// v9.23: silenced per-call 404 logs (Blockscout doesn't index this
// contract's instances at all, so every call 404s — noisy). First
// getLogs failure is logged once per process so RPC problems are
// still visible.
let _bsInstancesDisabled = false;
let _getLogsErrLogged    = false;

async function findMintTxBlockscout(nftId) {
  if (_bsInstancesDisabled) return null;
  try {
    const addr = CONTRACT.toLowerCase();
    const url = `https://base.blockscout.com/api/v2/tokens/${addr}/instances/${nftId}/transfers`;
    const r = await axios.get(url, { timeout: 10000 });
    const items = r.data?.items || [];
    for (const t of items) {
      const fromHash = (t.from?.hash || t.from || '').toLowerCase();
      if (fromHash === ZERO_ADDRESS) {
        return t.transaction_hash || t.tx_hash || t.hash || null;
      }
    }
  } catch (e) {
    if (e.response?.status === 404 && !_bsInstancesDisabled) {
      _bsInstancesDisabled = true;
      console.log(`[BS instances] 404 for nft=${nftId} — contract not indexed as token instances; disabling this lookup for the session.`);
    } else if (e.response?.status !== 404) {
      console.log(`[BS instances] nft=${nftId}: ${(e.message || '').slice(0, 60)}`);
    }
  }
  return null;
}

// v9.24: dedicated provider for log queries — Blockscout's eth-rpc
// endpoint, used as primary because it doesn't rate-limit topic-filtered
// queries the way mainnet.base.org does. v9.25 also keeps a fallback
// against the main provider with smaller chunks, since Blockscout's RPC
// sometimes returns empty for contracts it hasn't indexed as a token.
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

// v9.25: scan a bounded window backwards from the most recent block via
// chunked getLogs. Tries Blockscout's logs RPC first (no rate limit but
// sometimes returns empty for unindexed contracts), then falls back to
// the main provider with delays between chunks.
async function _scanLogsForMint(rpcLabel, lp, tokenIdHex, fromZeroTopic, latest, maxLookback, chunk, delayMs) {
  let chunksTried = 0, chunksFailed = 0;
  for (let offset = 0; offset < maxLookback; offset += chunk) {
    const toBlock   = latest - offset;
    const fromBlock = Math.max(0, toBlock - chunk + 1);
    if (toBlock < fromBlock) break;
    chunksTried++;
    try {
      const logs = await lp.getLogs({
        address: CONTRACT,
        topics: [TRANSFER_TOPIC, fromZeroTopic, null, tokenIdHex],
        fromBlock, toBlock,
      });
      if (logs.length) {
        console.log(`[${rpcLabel} hit] mint @ block=${logs[0].blockNumber} after ${chunksTried} chunks`);
        return logs[0].transactionHash;
      }
    } catch (e) {
      chunksFailed++;
      if (chunksFailed === 1) {
        console.log(`[${rpcLabel} err] first chunk failed: ${(e.message || '').slice(0, 80)}`);
      }
    }
    if (fromBlock === 0) break;
    if (delayMs) await new Promise(r => setTimeout(r, delayMs));
  }
  console.log(`[${rpcLabel} miss] no mint event in ${chunksTried} chunks (failed=${chunksFailed})`);
  return null;
}

async function findMintTxOnchain(nftId) {
  const tokenIdHex    = '0x' + BigInt(nftId).toString(16).padStart(64, '0');
  const fromZeroTopic = '0x' + '0'.repeat(64);

  // Try Blockscout RPC first — wide single chunk (it doesn't rate-limit).
  const lp = await getLogsProvider();
  if (lp) {
    try {
      const latest = await lp.getBlockNumber();
      // single very-wide chunk first (cheap when supported)
      const logs = await lp.getLogs({
        address: CONTRACT,
        topics: [TRANSFER_TOPIC, fromZeroTopic, null, tokenIdHex],
        fromBlock: Math.max(0, latest - 1_500_000),  // ~35 days on Base
        toBlock: latest,
      });
      if (logs.length) {
        console.log(`[blockscoutRPC hit] nft=${nftId} mint @ block=${logs[0].blockNumber}`);
        return logs[0].transactionHash;
      }
      console.log(`[blockscoutRPC miss] nft=${nftId} wide scan returned 0 logs — falling back to main RPC`);
    } catch (e) {
      console.log(`[blockscoutRPC err] nft=${nftId}: ${(e.message || '').slice(0, 80)} — falling back to main RPC`);
    }
  }

  // Fallback: main provider in 9999-block chunks with 200ms delay.
  // mainnet.base.org caps getLogs at 10k blocks and rate-limits aggressively.
  try {
    const latest = await provider.getBlockNumber();
    return await _scanLogsForMint('mainRPC', provider, tokenIdHex, fromZeroTopic, latest, 200_000, 9999, 250);
  } catch (e) {
    console.log(`[mainRPC scan err] nft=${nftId}: ${(e.message || '').slice(0, 80)}`);
  }
  return null;
}

async function findMintTxHash(nftId) {
  const fromBs = await findMintTxBlockscout(nftId);
  if (fromBs) return { hash: fromBs, src: 'blockscout' };
  const fromRpc = await findMintTxOnchain(nftId);
  if (fromRpc) return { hash: fromRpc, src: 'getLogs' };
  return null;
}

// v9.22: recover NFT → tier mapping from the chain when not in memory
// (e.g. after a bot restart, or when the BUY happened outside the history
// window). Handles multi-mint TXs: when a buyer mints N cards in one BUY,
// per-card price = totalUsdcPaid / N (so 5×$1 doesn't get misclassified
// as $5 = purple). Registers ALL minted NFTs from that BUY TX, not just
// the one being recovered — future claims for siblings will hit the map.
async function recoverTierFromBuyTx(nftId) {
  try {
    const found = await findMintTxHash(nftId);
    if (!found) {
      console.log(`[RECOVER fail] nft=${nftId}: mint TX not found via Blockscout or RPC`);
      return null;
    }
    const { hash: buyTxHash, src: lookupSrc } = found;

    const buyReceipt = await provider.getTransactionReceipt(buyTxHash);
    if (!buyReceipt) {
      console.log(`[RECOVER fail] nft=${nftId}: no receipt for ${buyTxHash.slice(0,10)}`);
      return null;
    }

    const allMints = findAllNftMints(buyReceipt);
    if (!allMints.length) {
      console.log(`[RECOVER fail] nft=${nftId}: no mints in ${buyTxHash.slice(0,10)}`);
      return null;
    }

    const mintForThis = allMints.find(m => m.nftId === String(nftId)) || allMints[0];
    const usdPaid     = findUsdcPayment(buyReceipt, mintForThis.to);
    const perCard     = usdPaid / allMints.length;
    const tier        = classifyByUsdc(perCard);

    if (tier) {
      const block = await provider.getBlock(buyReceipt.blockNumber).catch(() => null);
      const buyTs = block?.timestamp || 0;
      // Register every minted NFT in this BUY TX so sibling claims also hit.
      for (const m of allMints) {
        nftToTier.set(m.nftId, { tier, buyer: m.to, buyTxHash, buyTs });
      }
      console.log(`[RECOVER ${lookupSrc}] nft=${nftId} tier=${tier} (${TIER_INFO[tier].name}) totalPaid=$${usdPaid.toFixed(2)} mints=${allMints.length} perCard=$${perCard.toFixed(2)} from ${buyTxHash.slice(0,10)}`);
    } else {
      console.log(`[RECOVER no-tier ${lookupSrc}] nft=${nftId}: found BUY ${buyTxHash.slice(0,10)} but perCard=$${perCard.toFixed(2)} (totalPaid=$${usdPaid.toFixed(2)} mints=${allMints.length}) — not $1 / $5`);
    }
    return tier;
  } catch (e) {
    console.log(`[RECOVER fail] nft=${nftId}: ${(e.message || '').slice(0, 80)}`);
    return null;
  }
}

function nftIdFromCalldata(data) {
  if (!data || data.length < 74) return null;
  try { return BigInt('0x' + data.slice(10, 74)).toString(); }
  catch (_) { return null; }
}

function collectReceived(receipt, recipient) {
  // Combined collection: both contract-direct transfers (from === CONTRACT)
  // and mint-to-user events (from === 0x0) count as legitimate scratch card
  // rewards. Many tiers deliver part of the reward via .transfer() and part
  // via mint() — taking only one (v9.17) caused under-counting.
  //
  // sources[token] tracks where each token's amount came from ('C' = direct
  // from contract, 'M' = mint to user) so logs / /diag show the breakdown
  // and pricing oddities are traceable.
  //
  // Fallback (fromOther) only activates when neither direct nor mint paths
  // produced any received tokens — covers router/swap-routed rewards.
  const received = {};
  const sources  = {};
  const fromOther = {};

  for (const log of receipt.logs) {
    if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
    if (log.topics.length !== 3) continue; // ERC20 only; NFTs use 4 topics
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
    } else if (tokenAddr !== WETH_LOWER) {
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
    if (usd > PER_TOKEN_MAX_USD) {
      droppedSummary.push(`${info.symbol}=$${usd.toFixed(2)}(OUTLIER)`);
      return;
    }
    const psrc = priceCache[addr.toLowerCase()]?.src || '?';
    const fsrc = sources && sources[addr] ? Array.from(sources[addr]).sort().join('') : '?';
    totalUsd += usd;
    tokenSummary.push(`${info.symbol}=$${usd.toFixed(4)}`);
    tokenDetail.push(`${info.symbol}[${fsrc}] ${human.toFixed(6)} @ $${price.toFixed(8)}[${psrc}${label}] = $${usd.toFixed(4)}`);
  };

  const pending = []; // tokens that returned NO_PRICE on the first pass

  for (const [addr, rawAmt] of Object.entries(received)) {
    try {
      const info  = await getTokenInfo(addr);
      const human = Number(ethers.formatUnits(rawAmt, info.decimals));
      const price = await getTokenPriceUsd(addr);
      if (!price) { pending.push({ addr, info, human }); continue; }
      addPriced(addr, info, human, price, '');
    } catch (_) {}
  }

  // v9.20: second pass — retry every NO_PRICE token after a brief delay and
  // a cache bust. CoinGecko/DexScreener occasionally return empty/429 right
  // at claim time and recover seconds later; without this, the Telegram total
  // under-counts (e.g. $0.75) versus what /diag reports a minute later ($1.00).
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

  // Is this TX recent enough to treat as live even during history loading?
  // Covers the case where the bot restarts and a claim that just happened
  // lands in the 50-TX history window and would otherwise be silently eaten.
  const isRecentTx = blockTs >= BOT_START_TS - LIVE_WINDOW_SEC;

  let receipt;
  try { receipt = await provider.getTransactionReceipt(txHash); } catch (e) {
    if (!isLoadingHistory || isRecentTx)
      console.log(`[SKIP rpc-err] ${txHash.slice(0,10)}: ${e.message.slice(0,60)}`);
    return;
  }
  if (!receipt || receipt.status === 0) {
    if (!isLoadingHistory || isRecentTx)
      console.log(`[SKIP receipt] status=${receipt?.status ?? 'null'} | ${txHash.slice(0,10)}`);
    return;
  }

  const claimer = from.toLowerCase();

  // v9.22: support multi-mint BUY TXs (buyer mints N cards in one TX).
  // Per-card price = totalUsdcPaid / N. Without this, 5×$1 cards would be
  // misclassified as a single $5 purple, and siblings of the first NFT would
  // never get a tier mapping (only the first mint was registered before).
  const allMints = findAllNftMints(receipt);
  if (allMints.length) {
    const firstMint = allMints[0];
    const usdPaid   = findUsdcPayment(receipt, firstMint.to);
    const perCard   = usdPaid / allMints.length;
    const tier      = classifyByUsdc(perCard);
    if (tier) {
      for (const m of allMints) {
        nftToTier.set(m.nftId, { tier, buyer: m.to, buyTxHash: txHash, buyTs: blockTs });
      }
      if (!isLoadingHistory || isRecentTx)
        console.log(`[BUY] mints=${allMints.length} tier=${tier} (${TIER_INFO[tier].name}) totalPaid=$${usdPaid.toFixed(2)} perCard=$${perCard.toFixed(2)} buyer=${firstMint.to.slice(0,10)} ids=[${allMints.map(m=>m.nftId).join(',')}] | ${txHash.slice(0,10)}`);
    } else {
      if (!isLoadingHistory || isRecentTx)
        console.log(`[BUY ?] mints=${allMints.length} totalPaid=$${usdPaid.toFixed(2)} perCard=$${perCard.toFixed(2)} (tier yok) | ${txHash.slice(0,10)}`);
    }
    return;
  }

  // v9.24: check transfers FIRST. The contract receives many non-claim
  // calls (admin/setX/approve/transfer) where the first uint256 in calldata
  // is NOT an NFT id. Extracting it as one and logging `[SKIP no-transfer]
  // nft=3` floods the log with false positives. If the receipt has no
  // reward transfer to the caller, it is not a claim — drop silently.
  const { received, usedFallback, src, sources } = collectReceived(receipt, claimer);
  if (!Object.keys(received).length) return;

  let claimedNftId = null;
  const burn = findNftBurn(receipt);
  if (burn) claimedNftId = burn.nftId;
  if (!claimedNftId) claimedNftId = nftIdFromCalldata(data);

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

  // v9.21: tier is determined ONLY by the USDC payment in the BUY TX
  // ($1 = green, $5 = purple). If the in-memory NFT map doesn't have it,
  // recover by pulling the original mint event from Blockscout and reading
  // the USDC payment from that receipt. NEVER guess from the won amount —
  // a green ticket can legitimately win $30+.
  //
  // v9.23: only run recovery for live or recent TXs. Old history TXs only
  // affect stats (no notification fires), so paying the recovery cost for
  // them stalls startup; the count stays slightly behind for unrecognised
  // old claims, which is an acceptable trade for fast boot.
  if (tier === null && claimedNftId && (!isLoadingHistory || isRecentTx)) {
    tier = await recoverTierFromBuyTx(claimedNftId);
  }

  if (tier === null) {
    if (!isLoadingHistory || isRecentTx)
      console.log(`[SKIP unknown-tier] nft=${claimedNftId} won=$${totalUsd.toFixed(2)} (BUY TX bulunamadı) | ${txHash.slice(0,10)}`);
    return;
  }

  const tierInfo = TIER_INFO[tier];
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
  // Increment sessionCount for live TXs AND for recent TXs found in history.
  if (!isLoadingHistory || isRecentTx) state.sessionCount++;
  state.history.unshift({ usd: totalUsd, ts: blockTs * 1000, hash: txHash, claimer: from });
  if (state.history.length > Math.max(cycleSize, 200)) state.history.pop();

  // Suppress notifications for old history TXs; always notify for live and recent.
  if (isLoadingHistory && !isRecentTx) return;

  const pos        = state.sessionCount > 0 ? state.sessionCount : state.count;
  const posInCycle = ((pos - 1) % cycleSize) + 1;
  const remaining  = cycleSize - posInCycle;
  const date       = new Date(blockTs * 1000).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
  const txUrl      = `https://basescan.org/tx/${txHash}`;
  const cycleSlice = state.history.slice(0, posInCycle);
  const cycleAvg   = cycleSlice.reduce((s, c) => s + c.usd, 0) / (cycleSlice.length || 1);
  const avgLine    = [5, 10, 15, 20, 50, 100]
    .map(n => { const v = calcAvg(state.history, n); return v !== null ? `Avg${n} $${v.toFixed(2)}` : null; })
    .filter(Boolean).join(' | ');
  const sEmoji = state.streakDir === 'down' ? '🔴' : '🟢';
  const msg = [
    `${tierInfo.emoji} Total Value: $${totalUsd.toFixed(2)} [${tierInfo.name} / $${tierInfo.payUsd} USDC]`,
    `📍 Döngü: ${posInCycle}/${cycleSize} (~${remaining} kaldı) — Döngü Avg: $${cycleAvg.toFixed(2)}`,
    `${sEmoji} Streak: ${state.streak}`,
    avgLine ? `📊 ${avgLine}` : null,
    `👤 ${from}`,
    `🕐 ${date} | <a href="${txUrl}">TX</a>`,
  ].filter(Boolean).join('\n');

  console.log(`[✓] ${tierInfo.name} won=$${totalUsd.toFixed(2)} nft=${claimedNftId} cyc=${posInCycle}/${cycleSize} src=${src} | ${tokenDetail.join(' || ')} | ${txHash.slice(0,10)}`);
  await sendNotification(msg);
}

async function diagnoseTx(txHash) {
  const lines = [`🔍 TX: <code>${txHash}</code>`];
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
      const paid = findUsdcPayment(receipt, mint.to);
      const perCard = paid / (all.length || 1);
      const tier = classifyByUsdc(perCard);
      lines.push(`🛒 BUY TX: ${all.length} mint, totalPaid=$${paid.toFixed(2)}, perCard=$${perCard.toFixed(2)} → tier=${tier ?? '?'}`);
      lines.push(`   NFT id'ler: [${all.map(m => '#'+m.nftId).join(', ')}] → ${mint.to.slice(0,12)}`);
      if (nftToTier.has(mint.nftId)) lines.push(`  ✓ Map'te: ${JSON.stringify(nftToTier.get(mint.nftId)).slice(0,100)}`);
    } else if (burn) {
      lines.push(`🔥 CLAIM TX: NFT #${burn.nftId} burn from ${burn.from.slice(0,12)}`);
      if (nftToTier.has(burn.nftId)) {
        const m = nftToTier.get(burn.nftId);
        lines.push(`  ✓ Map'te tier=${m.tier} (${TIER_INFO[m.tier].name})`);
      } else {
        lines.push(`  ⚠️ NFT #${burn.nftId} map'te yok — fallback'e düşer`);
      }
    } else {
      const fromCd = nftIdFromCalldata(tx.data || '');
      lines.push(`❓ Mint/burn yok. Calldata'dan NFT id tahmini: ${fromCd ?? 'n/a'}`);
      if (fromCd && nftToTier.has(fromCd)) {
        const m = nftToTier.get(fromCd);
        lines.push(`  ✓ Map'te tier=${m.tier} (${TIER_INFO[m.tier].name})`);
      } else if (fromCd) {
        lines.push(`  🔎 Map'te yok — BUY TX'ten kurtarmaya çalışıyorum...`);
        const recovered = await recoverTierFromBuyTx(fromCd);
        if (recovered) {
          lines.push(`  ✓ Recovered tier=${recovered} (${TIER_INFO[recovered].name})`);
        } else {
          lines.push(`  ✗ BUY TX bulunamadı / USDC ödemesi $1 veya $5 değil`);
        }
      }
    }

    const { received, usedFallback, src, sources } = collectReceived(receipt, tx.from.toLowerCase());
    lines.push(`💸 Recipient transferi: ${Object.keys(received).length} (src=${src})`);
    if (Object.keys(received).length) {
      const { totalUsd, tokenDetail, droppedSummary } = await calcTotalUsd(received, sources);
      for (const t of tokenDetail)    lines.push(`  ✓ ${t}`);
      for (const d of droppedSummary) lines.push(`  ✗ ${d}`);
      lines.push(`💰 Toplam: $${totalUsd.toFixed(4)}`);
    }

    // Full audit: all ERC20 transfers to user, tagged by source
    const recipient = tx.from.toLowerCase();
    const allToUser = [];
    for (const log of receipt.logs) {
      if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
      if (log.topics.length !== 3) continue;
      const to      = ('0x' + log.topics[2].slice(26)).toLowerCase();
      const fromLog = ('0x' + log.topics[1].slice(26)).toLowerCase();
      if (to !== recipient) continue;
      if (!log.data || log.data === '0x') continue;
      const tokenAddr = log.address.toLowerCase();
      try {
        const info  = await getTokenInfo(tokenAddr);
        const human = Number(ethers.formatUnits(BigInt(log.data), info.decimals));
        const tag   = fromLog === CONTRACT_LOWER ? 'CONTRACT'
                    : fromLog === ZERO_ADDRESS    ? 'MINT'
                    : `OTHER(${fromLog.slice(0,8)})`;
        allToUser.push(`${info.symbol} ${human.toFixed(6)} ← ${tag}`);
      } catch (_) {}
    }
    if (allToUser.length) {
      lines.push(`📥 Tüm transferler (user'a):`);
      for (const a of allToUser) lines.push(`  • ${a}`);
    }

    if (processedTxs.has(txHash)) lines.push(`⚠️ Bu TX zaten işlendi`);
    lines.push(`📇 NFT map boyutu: ${nftToTier.size}`);
    lines.push(`📡 Kayıtlı chat: ${registeredChats.size}`);
  } catch (e) {
    lines.push(`❌ Hata: ${e.message.slice(0, 200)}`);
  }
  return lines.join('\n');
}

async function scanBlocks(fromBlock, toBlock) {
  const found = [];
  const BATCH = 8;
  for (let b = fromBlock; b <= toBlock; b += BATCH) {
    const end = Math.min(b + BATCH - 1, toBlock);
    const blocks = await Promise.all(
      Array.from({ length: end - b + 1 }, (_, i) =>
        provider.getBlock(b + i, true).catch(() => null)
      )
    );
    for (const block of blocks) {
      if (!block) continue;
      for (const tx of (block.prefetchedTransactions || [])) {
        if (tx.to?.toLowerCase() !== CONTRACT_LOWER) continue;
        found.push({
          hash: tx.hash, from: tx.from,
          data: tx.data || tx.input,
          blockNum: Number(block.number),
          blockTs:  Number(block.timestamp),
        });
      }
    }
  }
  return found;
}

async function loadHistory() {
  isLoadingHistory = true;
  console.log('[HISTORY] Blockscout API... (eski TX\'ler silent, son 5dk bildirimler açık)');
  const countBefore = { 1: ts(1).count, 2: ts(2).count };

  // (1) Direct-to-contract TXs — claims and direct BUYs.
  try {
    const r = await axios.get(
      `https://base.blockscout.com/api/v2/addresses/${CONTRACT}/transactions`,
      { params: { filter: 'to' }, timeout: 15000 }
    );
    const items = r.data?.items || [];
    console.log(`[HISTORY] ${items.length} direkt TX alındı, işleniyor...`);
    const txs = items
      .filter(tx => tx.status === 'ok')
      .sort((a, b) => a.block - b.block);
    for (const tx of txs) {
      try {
        const blockTs  = Math.floor(new Date(tx.timestamp).getTime() / 1000);
        const fromAddr = tx.from?.hash || tx.from;
        if (!fromAddr) continue;
        await processTx(tx.hash, fromAddr, tx.raw_input || '', tx.block, blockTs);
      } catch (_) {}
    }
  } catch (e) { console.error('[HISTORY tx]', e.message); }

  // (2) v9.25: catch BUYs that went through a router/proxy by scanning the
  // contract's recent mint events directly. The /transactions endpoint above
  // only returns TXs whose `to` field is the contract — router-routed
  // purchases (to=router) emit a mint Transfer event from the contract but
  // would otherwise be invisible to history loading, leaving nftToTier empty.
  try {
    const lp = await getLogsProvider();
    const useLp = lp || provider;
    const latest = await useLp.getBlockNumber();
    const fromZeroTopic = '0x' + '0'.repeat(64);
    const fromBlock = Math.max(0, latest - 100_000);  // ~2.3 days on Base
    let mintLogs = [];
    try {
      mintLogs = await useLp.getLogs({
        address: CONTRACT,
        topics: [TRANSFER_TOPIC, fromZeroTopic],
        fromBlock, toBlock: latest,
      });
    } catch (e) {
      console.log(`[HISTORY mints err] ${(e.message || '').slice(0, 80)} — fallback to chunked main RPC`);
      // Fallback: chunked scan via main provider
      const CHUNK = 9999;
      for (let off = 0; off < 100_000; off += CHUNK) {
        const to = latest - off;
        const fr = Math.max(0, to - CHUNK + 1);
        if (to < fr) break;
        try {
          const part = await provider.getLogs({
            address: CONTRACT,
            topics: [TRANSFER_TOPIC, fromZeroTopic],
            fromBlock: fr, toBlock: to,
          });
          mintLogs = mintLogs.concat(part);
        } catch (_) {}
        if (fr === 0) break;
        await new Promise(r => setTimeout(r, 250));
      }
    }
    const uniqueTxs = [...new Set(mintLogs.map(l => l.transactionHash))];
    console.log(`[HISTORY] ${mintLogs.length} mint log -> ${uniqueTxs.length} eşsiz BUY TX (son ~2.3 gün)`);
    for (const hash of uniqueTxs) {
      if (processedTxs.has(hash)) continue;
      try {
        const [tx, receipt] = await Promise.all([
          provider.getTransaction(hash).catch(() => null),
          provider.getTransactionReceipt(hash).catch(() => null),
        ]);
        if (!tx || !receipt) continue;
        const block = await provider.getBlock(receipt.blockNumber).catch(() => null);
        await processTx(hash, tx.from, tx.data || '', receipt.blockNumber, block?.timestamp || 0);
      } catch (_) {}
    }
  } catch (e) { console.error('[HISTORY mints]', e.message); }

  isLoadingHistory = false;
  const g = ts(1).count - countBefore[1];
  const p = ts(2).count - countBefore[2];
  console.log(`[HISTORY] Bitti — green=${g} purple=${p} yüklendi | NFT map=${nftToTier.size} | bildirimler açık`);
}

// v9.25: scan the contract's mint Transfer events in a block window.
// scanBlocks only sees TXs with `to=contract`, so router-routed BUYs
// (to=router, contract called internally) are invisible to it. Mint
// events are emitted from the contract regardless of caller, so they
// catch all BUYs.
async function scanMintLogs(from, to) {
  try {
    const lp = await getLogsProvider();
    const useLp = lp || provider;
    const fromZeroTopic = '0x' + '0'.repeat(64);
    const logs = await useLp.getLogs({
      address: CONTRACT,
      topics: [TRANSFER_TOPIC, fromZeroTopic],
      fromBlock: from, toBlock: to,
    });
    return [...new Set(logs.map(l => l.transactionHash))];
  } catch (_) {
    return [];
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

        // Direct-to-contract TXs (claims + direct BUYs).
        const txs  = await scanBlocks(from, to);
        for (const tx of txs)
          if (!processedTxs.has(tx.hash))
            await processTx(tx.hash, tx.from, tx.data, tx.blockNum, tx.blockTs);

        // Router-routed BUYs: any mint event from the contract in this range.
        const mintTxs = await scanMintLogs(from, to);
        for (const hash of mintTxs) {
          if (processedTxs.has(hash)) continue;
          try {
            const [tx, receipt] = await Promise.all([
              provider.getTransaction(hash).catch(() => null),
              provider.getTransactionReceipt(hash).catch(() => null),
            ]);
            if (!tx || !receipt) continue;
            const block = await provider.getBlock(receipt.blockNumber).catch(() => null);
            await processTx(hash, tx.from, tx.data || '', receipt.blockNumber, block?.timestamp || 0);
          } catch (_) {}
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
  const avgLines   = [5, 10, 15, 20, 50, 100]
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

const TIERS_ORDER = [1, 2];

async function startConversation(chatId) {
  const isNew = !registeredChats.has(String(chatId));
  registeredChats.add(String(chatId));
  if (isNew) console.log(`[TG] Yeni chat: ${chatId} (toplam: ${registeredChats.size})`);

  const lines = [`👋 <b>Scratch Card Tracker</b> ${VERSION}`, '', '✅ Bu chat bildirim listesine eklendi.', '', '📊 Döngü Sayıcıları:'];
  for (const t of TIERS_ORDER) {
    const info = TIER_INFO[t];
    lines.push(`  • ${info.emoji} ${info.name} ($${info.payUsd} USDC): Kaç paket açıldı? (?/${info.target})`);
  }
  lines.push('', '💬 Sırayla cevapla');
  await bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML' });
  conversations[chatId] = { step: 0, data: {} };
  const first = TIER_INFO[TIERS_ORDER[0]];
  await bot.sendMessage(chatId, `${first.emoji} ${first.name} ($${first.payUsd} USDC): Kaç paket açıldı? (?/${first.target})`);
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
    await bot.sendMessage(chatId, `${next.emoji} ${next.name} ($${next.payUsd} USDC): Kaç paket açıldı? (?/${next.target})`);
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
    const chatId = msg.chat.id;
    registeredChats.add(String(chatId));
    console.log(`[TG] Chat kaydedildi: ${chatId}`);
    await bot.sendMessage(chatId, '✅ Bu chat bildirim listesine eklendi.');
  });

  bot.onText(/\/stop/, async (msg) => {
    registeredChats.delete(String(msg.chat.id));
    await bot.sendMessage(msg.chat.id, '🔕 Bildirim listesinden çıkarıldı.');
  });

  bot.onText(/\/test/, async (msg) => {
    const chatId = msg.chat.id;
    registeredChats.add(String(chatId));
    try {
      await bot.sendMessage(chatId,
        `✅ <b>Test mesajı</b> ${VERSION}\n📡 Bot çalışıyor!\n📋 Kayıtlı chat: ${registeredChats.size}\n📇 NFT map: ${nftToTier.size}\n🟢 green (${SC1_TARGET}): ${ts(1).sessionCount} | 🟣 purple (${SC5_TARGET}): ${ts(2).sessionCount}`,
        { parse_mode: 'HTML' }
      );
    } catch (e) { console.error('[TEST]', e.message); }
  });

  bot.onText(/\/sc1/, (msg) => bot.sendMessage(msg.chat.id, buildTierMsg(1), { parse_mode: 'HTML' }).catch(console.error));
  bot.onText(/\/sc5/, (msg) => bot.sendMessage(msg.chat.id, buildTierMsg(2), { parse_mode: 'HTML' }).catch(console.error));

  bot.onText(/\/diag (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
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
      if (pollingErrCount === 1)
        console.error('[TG] 409 Conflict — başka bir instance aktif! Eski servisi durdur.');
      if (pollingErrCount > 80) { process.exit(1); }
    } else {
      pollingErrCount = 0;
      console.error('[TG polling]', e.message);
    }
  });

  console.log(`[${VERSION}] Contract: ${CONTRACT}`);
  console.log(`[${VERSION}] green=$1 döngü=${SC1_TARGET} | purple=$5 döngü=${SC5_TARGET}`);
  console.log(`[${VERSION}] BOT_START_TS=${BOT_START_TS} LIVE_WINDOW_SEC=${LIVE_WINDOW_SEC} CG_KEY=${COINGECKO_KEY ? 'yes' : 'no'}`);

  // v9.23: don't block polling on history. Live BUYs/CLAIMs were being
  // dropped because loadHistory() could take minutes when many NFT
  // recoveries fall back to chunked eth_getLogs. Start the live poller
  // immediately; history backfills stats in parallel.
  lastPollBlock = 0;
  loadHistory().then(() => {
    console.log(`[HISTORY] NFT map=${nftToTier.size} | green count=${ts(1).count} sessionCount=${ts(1).sessionCount}/${SC1_TARGET}  purple count=${ts(2).count} sessionCount=${ts(2).sessionCount}/${SC5_TARGET}`);
  }).catch(e => console.error('[HISTORY bg]', e?.message));
  await pollLoop();
}

main().catch(e => { console.error('[FATAL]', e); process.exit(1); });
