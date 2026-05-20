require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { ethers } = require('ethers');
const axios = require('axios');

const VERSION = 'v6';
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TELEGRAM_TOKEN) { console.error('TELEGRAM_BOT_TOKEN eksik!'); process.exit(1); }

const CONTRACT = (process.env.TOKEN_CONTRACT || '0xAe5F595803B2AA4D07aF8b392e535876a974a296').toLowerCase();

// Standart RPC'ler önce, blockscout sona — bazı RPC'lerde eth_call gerçek hatayı göstermez
const RPCS = [
  'https://mainnet.base.org',
  'https://base-rpc.publicnode.com',
  process.env.RPC_URL_1,
  process.env.RPC_URL_2,
  'https://base.gateway.tenderly.co',
  'https://base.blockscout.com/api/eth-rpc',
].filter(Boolean);

// Base sabitleri
const WETH             = '0x4200000000000000000000000000000000000006';
const USDC             = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const UNI_V3_FACTORY   = '0x33128a8fC17869897dcE68Ed026d694621f6FDfD';
const AERO_V3_FACTORY  = '0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A'; // Aerodrome Slipstream
const CHAINLINK_ETHUSD = '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70';

const FACTORY_ABI   = ['function getPool(address,address,uint24) view returns (address)'];
const POOL_ABI      = [
  'event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16,uint16,uint16,uint8,bool)',
];
const ERC20_ABI     = ['function decimals() view returns (uint8)','function symbol() view returns (string)','function name() view returns (string)'];
const CHAINLINK_ABI = ['function latestAnswer() view returns (int256)'];

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

let provider, poolContract, poolAddress, dexName='Uniswap V3';
let token0, token1, tokenIsToken0;
let tokenDecimals = 18, tokenSymbol = 'TOKEN', tokenName = '';
let quoteToken;
let recentSwaps = [];
let isReady = false, initErr = null;
let ethPriceCache = 0, ethPriceCacheAt = 0;
let workingRpc = null;

// ─── RPC ──────────────────────────────────────────────────────────────────
async function getProvider() {
  for (const rpc of RPCS) {
    try {
      const p = new ethers.JsonRpcProvider(rpc);
      await Promise.race([p.getBlockNumber(), new Promise((_,r)=>setTimeout(()=>r(new Error('timeout')),5000))]);
      console.log(`[RPC] ✓ ${rpc}`);
      workingRpc = rpc;
      return p;
    } catch(e) { console.log(`[RPC] ✗ ${rpc}: ${e.message}`); }
  }
  throw new Error('Hiçbir RPC bağlanamadı');
}

// ─── Contract var mı kontrolü ───────────────────────────────────────────────────
async function checkContract() {
  const code = await provider.getCode(CONTRACT);
  if (!code || code === '0x') throw new Error(`Contract ${CONTRACT.slice(0,10)}... Base'de bulunamadı (no bytecode)`);
  console.log(`[CODE] ${code.length} bytes`);
  return true;
}

// ─── Token bilgileri — Blockscout API + RPC fallback ────────────────────────────────
async function fetchTokenInfo() {
  // 1) Blockscout REST API
  try {
    const r = await axios.get(`https://base.blockscout.com/api/v2/tokens/${CONTRACT}`, { timeout: 8000 });
    const d = r.data;
    if (d?.symbol) {
      tokenSymbol   = d.symbol;
      tokenName     = d.name || d.symbol;
      tokenDecimals = parseInt(d.decimals || 18);
      console.log(`[BS-API] ${tokenName} (${tokenSymbol}) decimals=${tokenDecimals}`);
      return;
    }
  } catch(e) { console.log('[BS-API] hata:', e.message); }

  // 2) RPC üzerinden ERC20 çağrıları (catch ile)
  const erc20 = new ethers.Contract(CONTRACT, ERC20_ABI, provider);
  try { tokenSymbol   = await erc20.symbol();   console.log(`[ERC20] symbol=${tokenSymbol}`); } catch(_) {}
  try { tokenName     = await erc20.name();     console.log(`[ERC20] name=${tokenName}`);   } catch(_) {}
  try { tokenDecimals = Number(await erc20.decimals()); console.log(`[ERC20] decimals=${tokenDecimals}`); } catch(_) {}
}

// ─── ETH/USD ───────────────────────────────────────────────────────────────
async function getEthPrice() {
  if (Date.now() - ethPriceCacheAt < 60_000 && ethPriceCache > 0) return ethPriceCache;
  try {
    const cl = new ethers.Contract(CHAINLINK_ETHUSD, CHAINLINK_ABI, provider);
    ethPriceCache = Number(await cl.latestAnswer()) / 1e8;
    ethPriceCacheAt = Date.now();
    return ethPriceCache;
  } catch(e) { return ethPriceCache || 3000; }
}

// ─── Pool bul — Blockscout token-pools API önce ──────────────────────────────────
async function findPoolViaApi() {
  try {
    // Blockscout: token holders olarak DEX pool'ları listelenir
    const r = await axios.get(`https://base.blockscout.com/api/v2/tokens/${CONTRACT}/holders?limit=20`, { timeout: 10000 });
    const items = r.data?.items || [];
    for (const it of items) {
      const addr = it.address?.hash;
      if (!addr) continue;
      // Test: bu adres bir Uniswap V3 pool mu?
      try {
        const c = new ethers.Contract(addr, POOL_ABI, provider);
        const t0 = await c.token0();
        const t1 = await c.token1();
        const otherToken = t0.toLowerCase() === CONTRACT ? t1.toLowerCase() : t0.toLowerCase();
        if ([WETH.toLowerCase(), USDC.toLowerCase()].includes(otherToken)) {
          const name = otherToken === WETH.toLowerCase() ? 'WETH' : 'USDC';
          const decs = otherToken === WETH.toLowerCase() ? 18 : 6;
          console.log(`[POOL-API] ${addr} (${name})`);
          return { address: addr, quoteToken: { address: otherToken === WETH.toLowerCase()?WETH:USDC, name, decimals: decs } };
        }
      } catch(_) {}
    }
  } catch(e) { console.log('[POOL-API] hata:', e.message); }
  return null;
}

async function findPoolViaFactory() {
  const factory = new ethers.Contract(UNI_V3_FACTORY, FACTORY_ABI, provider);
  const quotes = [
    { address: WETH, name: 'WETH', decimals: 18 },
    { address: USDC, name: 'USDC', decimals: 6 },
  ];
  for (const qt of quotes) {
    for (const fee of [100, 500, 3000, 10000]) {
      try {
        const addr = await factory.getPool(CONTRACT, qt.address, fee);
        if (addr && addr !== ethers.ZeroAddress) {
          console.log(`[POOL-FACTORY] ${addr} (${qt.name} fee=${fee})`);
          return { address: addr, quoteToken: qt };
        }
      } catch(_) {}
    }
  }
  return null;
}

async function findPool() {
  // Önce API ile, sonra factory ile
  let found = await findPoolViaApi();
  if (!found) found = await findPoolViaFactory();
  return found;
}

async function swapToRate(amount0, amount1) {
  const tokenAmt = Math.abs(Number(ethers.formatUnits(tokenIsToken0 ? amount0 : amount1, tokenDecimals)));
  const quoteAmt = Math.abs(Number(ethers.formatUnits(tokenIsToken0 ? amount1 : amount0, quoteToken.decimals)));
  if (quoteAmt === 0) return null;
  const usd = quoteToken.address.toLowerCase() === WETH.toLowerCase()
    ? quoteAmt * (await getEthPrice())
    : quoteAmt;
  if (usd === 0) return null;
  return tokenAmt / usd;
}

async function getSpotPriceUsd() {
  const s = await poolContract.slot0();
  const p = (Number(s.sqrtPriceX96) / 2**96) ** 2;
  let tip;
  if (tokenIsToken0) tip = p * (10**quoteToken.decimals) / (10**tokenDecimals);
  else               tip = (1/p) * (10**tokenDecimals) / (10**quoteToken.decimals);
  return quoteToken.address.toLowerCase() === WETH.toLowerCase()
    ? tip * (await getEthPrice())
    : tip;
}

async function fetchHistory() {
  try {
    const cur = await provider.getBlockNumber();
    const evts = await poolContract.queryFilter(poolContract.filters.Swap(), cur - 2000, cur);
    console.log(`[HISTORY] ${evts.length} event`);
    const swaps = [];
    for (const e of evts.reverse()) {
      const { amount0, amount1 } = e.args;
      const isBuy = tokenIsToken0 ? amount0 < 0n : amount1 < 0n;
      if (!isBuy) continue;
      const rate = await swapToRate(amount0, amount1);
      if (rate && rate > 0) swaps.push({ tokensPerDollar: rate, ts: Date.now(), hash: e.transactionHash });
    }
    recentSwaps = [...swaps, ...recentSwaps]
      .filter((v,i,a) => a.findIndex(x => x.hash === v.hash) === i)
      .slice(0, 100);
    console.log(`[HISTORY] ${recentSwaps.length} buy kayıtlı`);
  } catch(e) { console.error('[HISTORY]', e.message); }
}

function startListener() {
  poolContract.on('Swap', async (sender, recipient, amount0, amount1) => {
    try {
      const isBuy = tokenIsToken0 ? amount0 < 0n : amount1 < 0n;
      if (!isBuy) return;
      const rate = await swapToRate(amount0, amount1);
      if (!rate || rate <= 0) return;
      recentSwaps.unshift({ tokensPerDollar: rate, ts: Date.now(), hash: null });
      if (recentSwaps.length > 100) recentSwaps.pop();
      console.log(`[SWAP] ${rate.toFixed(0)} token/$1`);
    } catch(e) { console.error('[SWAP]', e.message); }
  });
}

async function init() {
  try {
    provider = await getProvider();
    await checkContract();
    await fetchTokenInfo();

    const found = await findPool();
    if (!found) throw new Error(`Uniswap V3 pool bulunamadı. Contract: ${CONTRACT}`);

    poolAddress = found.address;
    quoteToken  = found.quoteToken;
    poolContract = new ethers.Contract(poolAddress, POOL_ABI, provider);
    token0 = (await poolContract.token0()).toLowerCase();
    token1 = (await poolContract.token1()).toLowerCase();
    tokenIsToken0 = token0 === CONTRACT;

    isReady = true;
    startListener();
    await fetchHistory();
    setInterval(() => fetchHistory().catch(console.error), 5 * 60_000);

    console.log(`[READY] ${tokenSymbol}/${quoteToken.name} pool=${poolAddress}`);
  } catch(e) {
    initErr = e.message;
    console.error('[INIT]', e);
  }
}

function fmt(n, d=0) {
  if (!n || isNaN(n)) return 'N/A';
  if (n >= 1e9) return (n/1e9).toFixed(2)+'B';
  if (n >= 1e6) return (n/1e6).toFixed(2)+'M';
  if (n >= 1e3) return (n/1e3).toFixed(2)+'K';
  return n.toFixed(d);
}
function avgOf(n) {
  const sl = recentSwaps.slice(0, n);
  if (!sl.length) return null;
  return sl.reduce((s,v) => s + v.tokensPerDollar, 0) / sl.length;
}

async function priceMsg() {
  if (!isReady) throw new Error(initErr || 'Bot hazır değil');
  const p = await getSpotPriceUsd();
  const last = recentSwaps[0];
  return `💎 *${tokenSymbol}* — BASE \`${VERSION}\`\n\n💰 *Spot:* \`$${p.toExponential(4)}\`\n\n🛒 *$1 paketi →* \`${fmt(1/p)} ${tokenSymbol}\`\n🛒 *$5 paketi →* \`${fmt(5/p)} ${tokenSymbol}\`\n\n📊 Son: ${last?fmt(last.tokensPerDollar)+' tok/$1':'yok'}\n🔄 Kayıt: ${recentSwaps.length}\n\n📝 \`${CONTRACT}\``;
}

async function avgMsg() {
  if (!isReady) throw new Error(initErr || 'Bot hazır değil');
  const PER = [5,10,15,20,25,50,100];
  const cur = recentSwaps[0]?.tokensPerDollar;
  let msg = `📈 *Paket Ortalamaları* (${tokenSymbol}/$1)\n🔄 ${recentSwaps.length} işlem\n\n`;
  for (const n of PER) {
    const avg = avgOf(n);
    if (avg === null) msg += `⚪ Son ${String(n).padEnd(3)}: yetersiz (${recentSwaps.length}/${n})\n`;
    else { const e = cur ? (cur >= avg ? '🟢' : '🔴') : '⚪'; msg += `${e} Son ${String(n).padEnd(3)}: \`${fmt(avg)} ${tokenSymbol}\`\n`; }
  }
  return msg;
}

async function fullMsg() {
  if (!isReady) throw new Error(initErr || 'Bot hazır değil');
  const p = await getSpotPriceUsd();
  const PER = [5,10,15,20,25,50,100];
  const cur = recentSwaps[0]?.tokensPerDollar;
  let lines = '';
  for (const n of PER) {
    const avg = avgOf(n);
    if (avg === null) lines += `⚪ Son ${String(n).padEnd(3)}: yetersiz\n`;
    else { const e = cur ? (cur >= avg ? '🟢' : '🔴') : '⚪'; lines += `${e} Son ${String(n).padEnd(3)}: \`${fmt(avg)}\` ($5: \`${fmt(avg*5)}\`)\n`; }
  }
  return `💎 *${tokenSymbol}* — BASE \`${VERSION}\`\n\n💰 Spot: \`$${p.toExponential(4)}\`\n🛒 $1→ \`${fmt(1/p)} ${tokenSymbol}\`   🛒 $5→ \`${fmt(5/p)} ${tokenSymbol}\`\n\n────────────────────\n📈 *Paket Ortalamaları*\n${lines}\n🔗 \`${poolAddress}\`\n📝 \`${CONTRACT}\``;
}

bot.onText(/\/start/, async (msg) => {
  const id = msg.chat.id;
  if (!isReady) return bot.sendMessage(id, `⏳ [${VERSION}] Bot başlatılıyor...\n${initErr ? '⚠️ '+initErr : ''}`);
  bot.sendMessage(id, `🤖 *${tokenSymbol} Tracker* \`${VERSION}\`\n\n📍 Base | 🔗 ${poolAddress?.slice(0,8)}...${poolAddress?.slice(-6)} (${quoteToken?.name})\n📊 ${recentSwaps.length} işlem\n\n/fiyat — Spot & $1/$5\n/ort   — 5/10/15/20/25/50/100 ort.\n/tum   — Hepsi`, { parse_mode: 'Markdown' });
});

bot.onText(/\/fiyat/, async (msg) => {
  const id=msg.chat.id, l=await bot.sendMessage(id,'⏳ Fiyat...');
  try { await bot.editMessageText(await priceMsg(),{chat_id:id,message_id:l.message_id,parse_mode:'Markdown'}); }
  catch(e){bot.editMessageText(`⚠️ ${e.message}`,{chat_id:id,message_id:l.message_id});}
});
bot.onText(/\/ort/, async (msg) => {
  const id=msg.chat.id, l=await bot.sendMessage(id,'⏳ Ortalamalar...');
  try { await bot.editMessageText(await avgMsg(),{chat_id:id,message_id:l.message_id,parse_mode:'Markdown'}); }
  catch(e){bot.editMessageText(`⚠️ ${e.message}`,{chat_id:id,message_id:l.message_id});}
});
bot.onText(/\/tum/, async (msg) => {
  const id=msg.chat.id, l=await bot.sendMessage(id,'⏳ ...');
  try { await bot.editMessageText(await fullMsg(),{chat_id:id,message_id:l.message_id,parse_mode:'Markdown'}); }
  catch(e){bot.editMessageText(`⚠️ ${e.message}`,{chat_id:id,message_id:l.message_id});}
});

bot.on('polling_error', e=>console.error('[polling]',e.message));
init().catch(console.error);
console.log(`🤖 ${VERSION} — ${CONTRACT} izleniyor...`);
