require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { ethers } = require('ethers');

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TELEGRAM_TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN eksik!');
  process.exit(1);
}

const CONTRACT = process.env.TOKEN_CONTRACT || '0xAe5F595803B2AA4D07aF8b392e535876a974a296';
// NETWORK sadece RPC fallback için kullanılır; chain DexScreener'dan otomatik algılanır
const NETWORK_HINT = (process.env.NETWORK || 'base').toLowerCase();

const RPCS = [
  process.env.RPC_URL_1,
  process.env.RPC_URL_2,
  process.env.RPC_URL_3,
  'https://mainnet.base.org',
  'https://base-rpc.publicnode.com',
  'https://base.gateway.tenderly.co',
].filter(Boolean);

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// Cache
let tokenPairCache  = null;
let detectedChain   = null;   // DexScreener'dan gelen gerçek chainId
let ohlcvHourly     = [];
let ohlcvHourlyTime = 0;
let priceCacheTime  = 0;
const PRICE_TTL = 20_000;
const OHLCV_TTL = 60_000;

// GeckoTerminal chainId eşlemesi (DexScreener chainId → GeckoTerminal network)
const CHAIN_MAP = {
  ethereum:  'eth',
  base:      'base',
  bsc:       'bsc',
  solana:    'solana',
  arbitrum:  'arbitrum',
  polygon:   'polygon',
  optimism:  'optimism',
  avalanche: 'avax',
};

function geckoNetwork(chainId) {
  return CHAIN_MAP[chainId?.toLowerCase()] || chainId?.toLowerCase() || NETWORK_HINT;
}

// DexScreener: en likit pair'i bul (chain filtresi YOK — otomatik algıla)
async function fetchPair() {
  const now = Date.now();
  if (tokenPairCache && now - priceCacheTime < PRICE_TTL) return tokenPairCache;

  const res = await axios.get(
    `https://api.dexscreener.com/latest/dex/tokens/${CONTRACT}`,
    { timeout: 12_000 }
  );

  const allPairs = res.data.pairs || [];
  if (!allPairs.length) throw new Error('DexScreener bu token için hiç pair döndürmedi');

  // Önce NETWORK_HINT ile eşleşenleri dene, bulamazsan tümünden en likit olanı al
  const filtered = allPairs.filter(p => p.chainId?.toLowerCase() === NETWORK_HINT);
  const pool     = (filtered.length ? filtered : allPairs)
    .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];

  detectedChain  = pool.chainId;   // örn. "base", "ethereum", "bsc"...
  tokenPairCache = pool;
  priceCacheTime = now;

  console.log(`[pair] chainId=${detectedChain} pair=${pool.pairAddress} liq=$${pool.liquidity?.usd || 0}`);
  return pool;
}

// GeckoTerminal: saatlik OHLCV
async function fetchOHLCV(pairAddress, limit = 100) {
  const now = Date.now();
  if (ohlcvHourly.length && now - ohlcvHourlyTime < OHLCV_TTL) return ohlcvHourly;

  const network = geckoNetwork(detectedChain);
  const url = `https://api.geckoterminal.com/api/v2/networks/${network}/pools/${pairAddress}/ohlcv/hour?limit=${limit}`;
  const res = await axios.get(url, {
    timeout: 15_000,
    headers: { Accept: 'application/json;version=20230302' },
  });
  const list = res.data?.data?.attributes?.ohlcv_list || [];
  ohlcvHourly     = list.reverse();
  ohlcvHourlyTime = now;
  return ohlcvHourly;
}

// GeckoTerminal: günlük OHLCV
async function fetchDailyOHLCV(pairAddress, limit = 100) {
  const network = geckoNetwork(detectedChain);
  const url = `https://api.geckoterminal.com/api/v2/networks/${network}/pools/${pairAddress}/ohlcv/day?limit=${limit}`;
  const res = await axios.get(url, {
    timeout: 15_000,
    headers: { Accept: 'application/json;version=20230302' },
  });
  return (res.data?.data?.attributes?.ohlcv_list || []).reverse();
}

// Yardımcılar
function ma(closes, period) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  return slice.reduce((s, v) => s + v, 0) / period;
}

function formatPrice(p) {
  if (p == null || isNaN(p)) return 'N/A';
  if (p < 0.000001) return p.toExponential(4);
  if (p < 0.0001)   return p.toFixed(9);
  if (p < 0.01)     return p.toFixed(7);
  if (p < 1)        return p.toFixed(6);
  return p.toFixed(4);
}

function fmt(n, dec = 2) {
  if (n == null || isNaN(n)) return 'N/A';
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: dec });
}

function tokenAmount(priceUsd, dollars) {
  if (!priceUsd || +priceUsd === 0) return 'N/A';
  const amt = dollars / parseFloat(priceUsd);
  if (amt >= 1_000_000) return fmt(amt / 1_000_000, 2) + 'M';
  if (amt >= 1_000)     return fmt(amt / 1_000,     2) + 'K';
  return fmt(amt, 0);
}

function diffPct(cur, ref) {
  if (!ref) return '?';
  const d = ((cur - ref) / ref) * 100;
  return (d >= 0 ? '+' : '') + d.toFixed(2) + '%';
}

const arrow = (cur, ref) => cur >= ref ? '🟢' : '🔴';

// Mesaj oluşturucular
async function buildPriceMsg() {
  const pair  = await fetchPair();
  const price = parseFloat(pair.priceUsd);
  const sym   = pair.baseToken?.symbol || 'TOKEN';
  const name  = pair.baseToken?.name   || sym;
  const c1h   = pair.priceChange?.h1  || 0;
  const c6h   = pair.priceChange?.h6  || 0;
  const c24h  = pair.priceChange?.h24 || 0;
  const vol   = pair.volume?.h24    || 0;
  const liq   = pair.liquidity?.usd || 0;
  const fdv   = pair.fdv            || 0;
  const txns  = (pair.txns?.h24?.buys || 0) + (pair.txns?.h24?.sells || 0);

  return (
    `💎 *${name}* (\`${sym}\`) — ${detectedChain?.toUpperCase()}\n\n` +
    `💰 *Fiyat:* \`$${formatPrice(price)}\`\n` +
    `${c1h  >= 0 ? '🟢' : '🔴'}  1s: ${c1h  >= 0 ? '+' : ''}${c1h.toFixed(2)}%\n` +
    `${c6h  >= 0 ? '🟢' : '🔴'}  6s: ${c6h  >= 0 ? '+' : ''}${c6h.toFixed(2)}%\n` +
    `${c24h >= 0 ? '🟢' : '🔴'} 24s: ${c24h >= 0 ? '+' : ''}${c24h.toFixed(2)}%\n\n` +
    `🛒 *$1  →* ${tokenAmount(price, 1)} ${sym}\n` +
    `🛒 *$5  →* ${tokenAmount(price, 5)} ${sym}\n\n` +
    `📊 Hacim (24s): $${fmt(vol)}\n` +
    `💧 Likidite:    $${fmt(liq)}\n` +
    `🏦 FDV:         $${fmt(fdv)}\n` +
    `🔄 TX (24s):    ${fmt(txns, 0)}\n\n` +
    `📝 \`${CONTRACT}\``
  );
}

async function buildMAMsg() {
  const PERIODS = [5, 10, 15, 20, 25, 50, 100];
  const pair    = await fetchPair();
  const price   = parseFloat(pair.priceUsd);
  const sym     = pair.baseToken?.symbol || 'TOKEN';
  let closes = [];
  try { closes = (await fetchOHLCV(pair.pairAddress, 100)).map(c => parseFloat(c[4])); } catch (_) {}

  let msg = `📈 *Hareketli Ortalamalar* (${sym} — saatlik)\n`;
  msg    += `💰 Güncel: \`$${formatPrice(price)}\`\n\n`;
  for (const p of PERIODS) {
    const avg = ma(closes, p);
    msg += avg === null
      ? `⚪ MA${String(p).padEnd(3)} — yetersiz veri (${closes.length}/${p})\n`
      : `${arrow(price, avg)} MA${String(p).padEnd(3)} \`$${formatPrice(avg)}\`  (${diffPct(price, avg)})\n`;
  }
  msg += `\n_Veri: ${closes.length} saatlik mum_`;
  return msg;
}

async function buildCycleMsg() {
  const pair  = await fetchPair();
  const price = parseFloat(pair.priceUsd);
  const sym   = pair.baseToken?.symbol || 'TOKEN';
  let closes = [];
  try { closes = (await fetchDailyOHLCV(pair.pairAddress, 100)).map(c => parseFloat(c[4])); } catch (_) {}

  const cycles = [
    { label: 'Kısa  (7G)',  days: 7  },
    { label: 'Orta  (14G)', days: 14 },
    { label: 'Uzun  (25G)', days: 25 },
    { label: 'Makro (50G)', days: 50 },
  ];
  let msg = `🔄 *Döngü Ortalamaları* (${sym} — günlük)\n`;
  msg    += `💰 Güncel: \`$${formatPrice(price)}\`\n\n`;
  for (const { label, days } of cycles) {
    const avg = ma(closes, days);
    msg += avg === null
      ? `⚪ ${label} — yetersiz veri (${closes.length}/${days}G)\n`
      : `${arrow(price, avg)} ${label}: \`$${formatPrice(avg)}\`  (${diffPct(price, avg)})\n`;
  }
  if (closes.length) {
    const ath = Math.max(...closes, price);
    const atl = Math.min(...closes.filter(x => x > 0), price);
    msg += `\n📌 ATH (${closes.length}G): \`$${formatPrice(ath)}\`  (${diffPct(price, ath)})\n`;
    msg += `📌 ATL (${closes.length}G): \`$${formatPrice(atl)}\`  (${diffPct(price, atl)})\n`;
  }
  msg += `\n_Veri: ${closes.length} günlük mum_`;
  return msg;
}

async function buildFullMsg() {
  const PERIODS = [5, 10, 15, 20, 25, 50, 100];
  const pair    = await fetchPair();
  const price   = parseFloat(pair.priceUsd);
  const sym     = pair.baseToken?.symbol || 'TOKEN';
  const name    = pair.baseToken?.name   || sym;
  const c1h     = pair.priceChange?.h1  || 0;
  const c24h    = pair.priceChange?.h24 || 0;
  const vol     = pair.volume?.h24    || 0;
  const liq     = pair.liquidity?.usd || 0;

  let hourlyCloses = [], dailyCloses = [];
  try { hourlyCloses = (await fetchOHLCV(pair.pairAddress, 100)).map(c => parseFloat(c[4])); } catch (_) {}
  try { dailyCloses  = (await fetchDailyOHLCV(pair.pairAddress, 100)).map(c => parseFloat(c[4])); } catch (_) {}

  let maLines = '';
  for (const p of PERIODS) {
    const avg = ma(hourlyCloses, p);
    maLines += avg !== null
      ? `${arrow(price, avg)} MA${String(p).padEnd(3)} \`$${formatPrice(avg)}\`  (${diffPct(price, avg)})\n`
      : `⚪ MA${p} — yetersiz veri\n`;
  }
  const cycles = [
    { label: 'Kısa  7G',  days: 7  },
    { label: 'Orta  14G', days: 14 },
    { label: 'Uzun  25G', days: 25 },
    { label: 'Makro 50G', days: 50 },
  ];
  let cycleLines = '';
  for (const { label, days } of cycles) {
    const avg = ma(dailyCloses, days);
    cycleLines += avg !== null
      ? `${arrow(price, avg)} ${label}: \`$${formatPrice(avg)}\`  (${diffPct(price, avg)})\n`
      : `⚪ ${label} — yetersiz veri\n`;
  }
  return (
    `💎 *${name}* (\`${sym}\`) — ${detectedChain?.toUpperCase()}\n\n` +
    `💰 *Fiyat:* \`$${formatPrice(price)}\`\n` +
    `${c1h  >= 0 ? '🟢' : '🔴'} 1s: ${c1h  >= 0 ? '+' : ''}${c1h.toFixed(2)}%   ` +
    `${c24h >= 0 ? '🟢' : '🔴'} 24s: ${c24h >= 0 ? '+' : ''}${c24h.toFixed(2)}%\n\n` +
    `🛒 *$1 →* ${tokenAmount(price, 1)} ${sym}   |   *$5 →* ${tokenAmount(price, 5)} ${sym}\n` +
    `📊 Hacim: $${fmt(vol)}   💧 Liq: $${fmt(liq)}\n\n` +
    `────────────────────\n` +
    `📈 *Hareketli Ortalamalar (saatlik)*\n${maLines}\n` +
    `🔄 *Döngü Ortalamaları (günlük)*\n${cycleLines}\n` +
    `📝 \`${CONTRACT}\``
  );
}

// Komutlar
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const pair = await fetchPair();
    const sym  = pair.baseToken?.symbol || 'TOKEN';
    await bot.sendMessage(chatId,
      `🤖 *Token Tracker Bot*\n\n` +
      `📍 *Token:* ${sym} (${detectedChain?.toUpperCase()})\n` +
      `📝 \`${CONTRACT}\`\n\n` +
      `📋 *Komutlar:*\n` +
      `/fiyat  — Anlık fiyat & $1/$5 alım değerleri\n` +
      `/ort    — Hareketli ortalamalar (MA5…MA100)\n` +
      `/dongu  — Döngü ortalamaları (7G/14G/25G/50G)\n` +
      `/tum    — Tüm veriler tek mesajda`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    bot.sendMessage(chatId, `⚠️ Başlatılamadı: ${err.message}`);
  }
});

bot.onText(/\/fiyat/, async (msg) => {
  const chatId = msg.chat.id;
  const l = await bot.sendMessage(chatId, '⏳ Fiyat alınıyor…');
  try {
    await bot.editMessageText(await buildPriceMsg(), { chat_id: chatId, message_id: l.message_id, parse_mode: 'Markdown' });
  } catch (err) { bot.editMessageText(`⚠️ Hata: ${err.message}`, { chat_id: chatId, message_id: l.message_id }); }
});

bot.onText(/\/ort/, async (msg) => {
  const chatId = msg.chat.id;
  const l = await bot.sendMessage(chatId, '⏳ Ortalamalar hesaplanıyor…');
  try {
    await bot.editMessageText(await buildMAMsg(), { chat_id: chatId, message_id: l.message_id, parse_mode: 'Markdown' });
  } catch (err) { bot.editMessageText(`⚠️ Hata: ${err.message}`, { chat_id: chatId, message_id: l.message_id }); }
});

bot.onText(/\/dongu/, async (msg) => {
  const chatId = msg.chat.id;
  const l = await bot.sendMessage(chatId, '⏳ Döngü hesaplanıyor…');
  try {
    await bot.editMessageText(await buildCycleMsg(), { chat_id: chatId, message_id: l.message_id, parse_mode: 'Markdown' });
  } catch (err) { bot.editMessageText(`⚠️ Hata: ${err.message}`, { chat_id: chatId, message_id: l.message_id }); }
});

bot.onText(/\/tum/, async (msg) => {
  const chatId = msg.chat.id;
  const l = await bot.sendMessage(chatId, '⏳ Tüm veriler alınıyor…');
  try {
    await bot.editMessageText(await buildFullMsg(), { chat_id: chatId, message_id: l.message_id, parse_mode: 'Markdown' });
  } catch (err) { bot.editMessageText(`⚠️ Hata: ${err.message}`, { chat_id: chatId, message_id: l.message_id }); }
});

bot.on('polling_error', (err) => console.error('[polling]', err.message));

console.log('🤖 Token Tracker Bot başlatıldı!');
console.log(`📍 Contract : ${CONTRACT}`);
console.log('Komutlar   : /start /fiyat /ort /dongu /tum');
