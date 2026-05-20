require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { ethers } = require('ethers');

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TELEGRAM_TOKEN) { console.error('TELEGRAM_BOT_TOKEN eksik!'); process.exit(1); }

const CONTRACT  = (process.env.TOKEN_CONTRACT || '0xAe5F595803B2AA4D07aF8b392e535876a974a296');
const RPCS = [
  'https://base.blockscout.com/api/eth-rpc',
  process.env.RPC_URL_1,
  process.env.RPC_URL_2,
  'https://mainnet.base.org',
  'https://base-rpc.publicnode.com',
  'https://base.gateway.tenderly.co',
].filter(Boolean);

// Base network constants
const WETH            = '0x4200000000000000000000000000000000000006';
const USDC            = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const UNI_V3_FACTORY  = '0x33128a8fC17869897dcE68Ed026d694621f6FDfD';
const CHAINLINK_ETHUSD= '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70';

const FACTORY_ABI  = ['function getPool(address,address,uint24) view returns (address)'];
const POOL_ABI     = [
  'event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16,uint16,uint16,uint8,bool)',
];
const ERC20_ABI    = ['function decimals() view returns (uint8)','function symbol() view returns (string)'];
const CHAINLINK_ABI= ['function latestAnswer() view returns (int256)'];

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// State
let provider, poolContract, poolAddress;
let token0, token1, tokenIsToken0;
let tokenDecimals = 18, tokenSymbol = 'TOKEN';
let quoteToken;           // { address, name, decimals }
let recentSwaps = [];     // { tokensPerDollar, ts, hash }
let isReady = false;
let initErr = null;
let ethPriceCache = 0, ethPriceCacheAt = 0;

// ─── RPC ──────────────────────────────────────────────────────────────────────
async function getProvider() {
  for (const rpc of RPCS) {
    try {
      const p = new ethers.JsonRpcProvider(rpc);
      await Promise.race([p.getBlockNumber(), new Promise((_,r)=>setTimeout(()=>r(new Error('timeout')),5000))]);
      console.log(`[RPC] OK: ${rpc}`);
      return p;
    } catch(e) { console.log(`[RPC] fail ${rpc}: ${e.message}`); }
  }
  throw new Error('Hiçbir RPC bağlanamadı');
}

// ─── ETH/USD fiyatı (Chainlink) ───────────────────────────────────────────────
async function getEthPrice() {
  if (Date.now() - ethPriceCacheAt < 60_000 && ethPriceCache > 0) return ethPriceCache;
  try {
    const cl = new ethers.Contract(CHAINLINK_ETHUSD, CHAINLINK_ABI, provider);
    const ans = await cl.latestAnswer();
    ethPriceCache = Number(ans) / 1e8;
    ethPriceCacheAt = Date.now();
    console.log(`[ETH] $${ethPriceCache}`);
    return ethPriceCache;
  } catch(e) {
    console.warn('[ETH] Chainlink hata, fallback 3000:', e.message);
    return ethPriceCache || 3000;
  }
}

// ─── Pool bul ─────────────────────────────────────────────────────────────────
async function findPool() {
  const factory = new ethers.Contract(UNI_V3_FACTORY, FACTORY_ABI, provider);
  const quotes = [
    { address: WETH, name: 'WETH', decimals: 18 },
    { address: USDC, name: 'USDC', decimals: 6  },
  ];
  for (const qt of quotes) {
    for (const fee of [100, 500, 3000, 10000]) {
      try {
        const addr = await factory.getPool(CONTRACT, qt.address, fee);
        if (addr && addr !== ethers.ZeroAddress) {
          console.log(`[POOL] ${addr} (${qt.name} fee=${fee})`);
          return { address: addr, quoteToken: qt };
        }
      } catch(_) {}
    }
  }
  return null;
}

// ─── Swap → tokens/$1 hesapla ─────────────────────────────────────────────────
async function swapToRate(amount0, amount1) {
  const tokenAmt = Math.abs(Number(ethers.formatUnits(
    tokenIsToken0 ? amount0 : amount1, tokenDecimals
  )));
  const quoteAmt = Math.abs(Number(ethers.formatUnits(
    tokenIsToken0 ? amount1 : amount0, quoteToken.decimals
  )));
  if (quoteAmt === 0) return null;

  let usdValue;
  if (quoteToken.address.toLowerCase() === WETH.toLowerCase()) {
    usdValue = quoteAmt * (await getEthPrice());
  } else {
    usdValue = quoteAmt; // USDC ≈ $1
  }
  if (usdValue === 0) return null;
  return tokenAmt / usdValue; // kaç token / $1
}

// ─── Güncel spot fiyatı (slot0'dan) ──────────────────────────────────────────
async function getSpotPriceUsd() {
  const slot0 = await poolContract.slot0();
  const sqrtP = Number(slot0.sqrtPriceX96);
  const price96sq = (sqrtP / 2**96) ** 2;

  let tokenPriceInQuote;
  if (tokenIsToken0) {
    // price = token1/token0, adjust decimals
    tokenPriceInQuote = price96sq * (10**quoteToken.decimals) / (10**tokenDecimals);
  } else {
    tokenPriceInQuote = (1 / price96sq) * (10**tokenDecimals) / (10**quoteToken.decimals);
  }

  if (quoteToken.address.toLowerCase() === WETH.toLowerCase()) {
    return tokenPriceInQuote * (await getEthPrice());
  }
  return tokenPriceInQuote;
}

// ─── Geçmiş swapları çek ─────────────────────────────────────────────────────
async function fetchHistory() {
  try {
    const cur   = await provider.getBlockNumber();
    const from  = cur - 2000; // ~7 dakika
    const evts  = await poolContract.queryFilter(poolContract.filters.Swap(), from, cur);
    console.log(`[HISTORY] ${evts.length} event`);

    const swaps = [];
    for (const e of evts.reverse()) {
      const { amount0, amount1 } = e.args;
      const isBuy = tokenIsToken0 ? amount0 < 0n : amount1 < 0n;
      if (!isBuy) continue;
      const rate = await swapToRate(amount0, amount1);
      if (rate && rate > 0) swaps.push({ tokensPerDollar: rate, ts: Date.now(), hash: e.transactionHash });
    }
    // birleştir, en fazla 100 tut
    recentSwaps = [...swaps, ...recentSwaps]
      .filter((v, i, a) => a.findIndex(x => x.hash === v.hash) === i)
      .slice(0, 100);
    console.log(`[HISTORY] ${recentSwaps.length} buy kayıtlı`);
  } catch(e) { console.error('[HISTORY]', e.message); }
}

// ─── Canlı dinleyici ──────────────────────────────────────────────────────────
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

// ─── Başlat ───────────────────────────────────────────────────────────────────
async function init() {
  try {
    provider = await getProvider();
    const erc20 = new ethers.Contract(CONTRACT, ERC20_ABI, provider);
    [tokenDecimals, tokenSymbol] = await Promise.all([erc20.decimals(), erc20.symbol()]);
    console.log(`[TOKEN] ${tokenSymbol} decimals=${tokenDecimals}`);

    const found = await findPool();
    if (!found) throw new Error(`Uniswap V3'te pool bulunamadı. Contract doğru mu?`);

    poolAddress   = found.address;
    quoteToken    = found.quoteToken;
    poolContract  = new ethers.Contract(poolAddress, POOL_ABI, provider);
    token0        = (await poolContract.token0()).toLowerCase();
    token1        = (await poolContract.token1()).toLowerCase();
    tokenIsToken0 = token0 === CONTRACT.toLowerCase();

    console.log(`[POOL] token0=${token0} tokenIsToken0=${tokenIsToken0}`);

    isReady = true;
    startListener();
    await fetchHistory();

    setInterval(() => fetchHistory().catch(console.error), 5 * 60_000);
    console.log(`[READY] ${tokenSymbol}/${quoteToken.name} pool=${poolAddress}`);
  } catch(e) {
    initErr = e.message;
    console.error('[INIT ERROR]', e.message);
  }
}

// ─── Format ───────────────────────────────────────────────────────────────────
function fmt(n, d = 0) {
  if (!n || isNaN(n)) return 'N/A';
  if (n >= 1e9) return (n/1e9).toFixed(2)+'B';
  if (n >= 1e6) return (n/1e6).toFixed(2)+'M';
  if (n >= 1e3) return (n/1e3).toFixed(2)+'K';
  return n.toFixed(d);
}

function avgOf(n) {
  const sl = recentSwaps.slice(0, n);
  if (!sl.length) return null;
  return sl.reduce((s, v) => s + v.tokensPerDollar, 0) / sl.length;
}

// ─── Mesajlar ─────────────────────────────────────────────────────────────────
async function priceMsg() {
  if (!isReady) throw new Error(initErr || 'Bot hazır değil, lütfen bekleyin');
  const priceUsd = await getSpotPriceUsd();
  const t1 = fmt(1 / priceUsd);
  const t5 = fmt(5 / priceUsd);
  const last = recentSwaps[0];
  return (
    `💎 *${tokenSymbol}* — BASE\n\n` +
    `💰 *Spot:* \`$${priceUsd.toExponential(4)}\`\n\n` +
    `🛒 *$1 paketi →* \`${t1} ${tokenSymbol}\`\n` +
    `🛒 *$5 paketi →* \`${t5} ${tokenSymbol}\`\n\n` +
    `📊 Son işlem: ${last ? fmt(last.tokensPerDollar)+' token/$1' : 'yok'}\n` +
    `🔄 Kayıtlı işlem: ${recentSwaps.length}\n\n` +
    `📝 \`${CONTRACT}\``
  );
}

async function avgMsg() {
  if (!isReady) throw new Error(initErr || 'Bot hazır değil');
  const PERIODS = [5,10,15,20,25,50,100];
  const cur = recentSwaps[0]?.tokensPerDollar;
  let msg = `📈 *Paket Ortalamaları* (${tokenSymbol} / $1)\n🔄 Kayıtlı: ${recentSwaps.length} işlem\n\n`;
  for (const n of PERIODS) {
    const avg = avgOf(n);
    if (avg === null) {
      msg += `⚪ Son ${String(n).padEnd(3)}: yetersiz veri (${recentSwaps.length}/${n})\n`;
    } else {
      const e = cur ? (cur >= avg ? '🟢' : '🔴') : '⚪';
      msg += `${e} Son ${String(n).padEnd(3)}: \`${fmt(avg)} ${tokenSymbol}\`\n`;
    }
  }
  return msg;
}

async function fullMsg() {
  if (!isReady) throw new Error(initErr || 'Bot hazır değil');
  const priceUsd = await getSpotPriceUsd();
  const t1 = fmt(1 / priceUsd);
  const t5 = fmt(5 / priceUsd);
  const PERIODS = [5,10,15,20,25,50,100];
  const cur = recentSwaps[0]?.tokensPerDollar;

  let avgLines = '';
  for (const n of PERIODS) {
    const avg = avgOf(n);
    if (avg === null) {
      avgLines += `⚪ Son ${String(n).padEnd(3)}: yetersiz (${recentSwaps.length}/${n})\n`;
    } else {
      const e = cur ? (cur >= avg ? '🟢' : '🔴') : '⚪';
      avgLines += `${e} Son ${String(n).padEnd(3)}: \`${fmt(avg)}\` token/$1   ($5: \`${fmt(avg*5)}\`)\n`;
    }
  }

  return (
    `💎 *${tokenSymbol}* — BASE\n\n` +
    `💰 *Spot:* \`$${priceUsd.toExponential(4)}\`\n\n` +
    `🛒 *$1 →* \`${t1} ${tokenSymbol}\`\n` +
    `🛒 *$5 →* \`${t5} ${tokenSymbol}\`\n\n` +
    `────────────────────\n` +
    `📈 *Paket Ortalamaları*\n${avgLines}\n` +
    `🔗 Pool: \`${poolAddress}\`\n` +
    `📝 \`${CONTRACT}\``
  );
}

// ─── Komutlar ─────────────────────────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
  const id = msg.chat.id;
  if (!isReady) return bot.sendMessage(id, `⏳ Bot başlatılıyor...\n${initErr ? '⚠️ '+initErr : 'Lütfen 10-20 saniye bekleyin.'}`);
  bot.sendMessage(id,
    `🤖 *${tokenSymbol} Tracker*\n\n` +
    `📍 Base Network\n` +
    `🔗 Pool: \`${poolAddress?.slice(0,8)}...${poolAddress?.slice(-6)}\` (${quoteToken?.name})\n` +
    `📊 ${recentSwaps.length} işlem kayıtlı\n\n` +
    `📋 *Komutlar:*\n` +
    `/fiyat — Spot fiyat & $1/$5 paket\n` +
    `/ort   — Son 5/10/15/20/25/50/100 işlem ortalaması\n` +
    `/tum   — Her şey tek mesajda`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/fiyat/, async (msg) => {
  const id=msg.chat.id, l=await bot.sendMessage(id,'⏳ Fiyat alınıyor...');
  try { await bot.editMessageText(await priceMsg(),{chat_id:id,message_id:l.message_id,parse_mode:'Markdown'}); }
  catch(e){bot.editMessageText(`⚠️ ${e.message}`,{chat_id:id,message_id:l.message_id});}
});

bot.onText(/\/ort/, async (msg) => {
  const id=msg.chat.id, l=await bot.sendMessage(id,'⏳ Ortalamalar...');
  try { await bot.editMessageText(await avgMsg(),{chat_id:id,message_id:l.message_id,parse_mode:'Markdown'}); }
  catch(e){bot.editMessageText(`⚠️ ${e.message}`,{chat_id:id,message_id:l.message_id});}
});

bot.onText(/\/tum/, async (msg) => {
  const id=msg.chat.id, l=await bot.sendMessage(id,'⏳ Yükleniyor...');
  try { await bot.editMessageText(await fullMsg(),{chat_id:id,message_id:l.message_id,parse_mode:'Markdown'}); }
  catch(e){bot.editMessageText(`⚠️ ${e.message}`,{chat_id:id,message_id:l.message_id});}
});

bot.on('polling_error', e=>console.error('[polling]',e.message));

init().catch(console.error);
console.log(`🤖 ${CONTRACT} tracker başlatılıyor...`);
