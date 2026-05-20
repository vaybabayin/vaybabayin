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
const NETWORK = process.env.NETWORK || 'base';

// RPCs - Base network (rips-bot uyumlu fallback listesi)
const RPCS = [
  process.env.RPC_URL_1,
  process.env.RPC_URL_2,
  process.env.RPC_URL_3,
  'https://mainnet.base.org',
  'https://base-rpc.publicnode.com',
  'https://base.gateway.tenderly.co',
  '1rpc.io/base',
].filter(Boolean);

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// ------ Cache ------
let tokenPairCache = null;
let ohlcvHourlyCache = [];
let ohlcvCacheTime = 0;
let priceCacheTime = 0;
const PRICE_TTL = 20_000;  // 20s
const OHLCV_TTL = 60_000;  // 1m

// ------ RPC Provider with fallback ------
function getProvider() {
  for (const rpc of RPCS) {
    try {
      return new ethers.JsonRpcProvider(rpc);
    } catch (_) {}
  }
  throw new Error('Hiçbir RPC bağlanamadı');
}

// ------ DexScreener: pair + spot price ------
async function fetchPair() {
  const now = Date.now();
  if (tokenPairCache && now - priceCacheTime < PRICE_TTL) return tokenPairCache;

  const res = await axios.get(
    `https://api.dexscreener.com/latest/dex/tokens/${CONTRACT}`,
    { timeout: 12_000 }
  );
  const pairs = (res.data.pairs || []).filter(p => p.chainId === NETWORK);
  if (!pairs.length) throw new Error('Pair bulunamadı (DexScreener)');

  // En yüksek likiditeye sahip pair
  const pair = pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
  tokenPairCache = pair;
  priceCacheTime = now;
  return pair;
}

// ------ GeckoTerminal: saatlik OHLCV (100 mum) ------
async function fetchOHLCV(pairAddress, limit = 100) {
  const now = Date.now();
  if (ohlcvHourlyCache.length && now - ohlcvCacheTime < OHLCV_TTL) return ohlcvHourlyCache;

  const url = `https://api.geckoterminal.com/api/v2/networks/${NETWORK}/pools/${pairAddress}/ohlcv/hour?limit=${limit}`;
  const res = await axios.get(url, {
    timeout: 15_000,
    headers: { Accept: 'application/json;version=20230302' },
  });
  const list = res.data?.data?.attributes?.ohlcv_list || [];
  // [ [timestamp, open, high, low, close, volume], ... ] — en yeni sonunda
  ohlcvHourlyCache = list.reverse(); // eski → yeni
  ohlcvCacheTime = now;
  return ohlcvHourlyCache;
}

// ------ GeckoTerminal: günlük OHLCV döngü hesabı için ------
async function fetchDailyOHLCV(pairAddress, limit = 100) {
  const url = `https://api.geckoterminal.com/api/v2/networks/${NETWORK}/pools/${pairAddress}/ohlcv/day?limit=${limit}`;
  const res = await axios.get(url, {
    timeout: 15_000,
    headers: { Accept: 'application/json;version=20230302' },
  });
  const list = res.data?.data?.attributes?.ohlcv_list || [];
  return list.reverse();
}

// ------ Hesaplama yardımcıları ------
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
  if (!priceUsd || priceUsd === 0) return 'N/A';
  const amt = dollars / parseFloat(priceUsd);
  if (amt >= 1_000_000) return fmt(amt / 1_000_000, 2) + 'M';
  if (amt >= 1_000)     return fmt(amt / 1_000, 2) + 'K';
  return fmt(amt, 0);
}

function diffPct(current, ref) {
  if (!ref || ref === 0) return '?';
  const d = ((current - ref) / ref) * 100;
  return (d >= 0 ? '+' : '') + d.toFixed(2) + '%';
}

function changeEmoji(current, ref) {
  return current >= ref ? '🟢' : '🔴';
}

// ------ Mesaj oluşturucular ------
async function buildPriceMsg() {
  const pair  = await fetchPair();
  const price = parseFloat(pair.priceUsd);
  const sym   = pair.baseToken?.symbol || 'TOKEN';
  const name  = pair.baseToken?.name   || sym;

  const c1h  = pair.priceChange?.h1  || 0;
  const c6h  = pair.priceChange?.h6  || 0;
  const c24h = pair.priceChange?.h24 || 0;
  const vol  = pair.volume?.h24 || 0;
  const liq  = pair.liquidity?.usd || 0;
  const fdv  = pair.fdv || 0;
  const txns = pair.txns?.h24?.buys + pair.txns?.h24?.sells || 0;

  const e1h  = c1h  >= 0 ? '🟢' : '🔴';
  const e6h  = c6h  >= 0 ? '🟢' : '🔴';
  const e24h = c24h >= 0 ? '🟢' : '🔴';

  return (
    `💎 *${name}* (\`${sym}\`)

` +
    `💰 *Fiyat:* \`$${formatPrice(price)}\`
` +
    `${e1h}  1s: ${c1h >= 0 ? '+' : ''}${c1h.toFixed(2)}%
` +
    `${e6h}  6s: ${c6h >= 0 ? '+' : ''}${c6h.toFixed(2)}%
` +
    `${e24h} 24s: ${c24h >= 0 ? '+' : ''}${c24h.toFixed(2)}%

` +
    `🛒 *$1 alım →* ${tokenAmount(price, 1)} ${sym}
` +
    `🛒 *$5 alım →* ${tokenAmount(price, 5)} ${sym}

` +
    `📊 Hacim (24s): $${fmt(vol)}
` +
    `💧 Likidite:    $${fmt(liq)}
` +
    `🏦 FDV:         $${fmt(fdv)}
` +
    `🔄 TX (24s):    ${fmt(txns, 0)}

` +
    `📝 \`${CONTRACT.slice(0, 8)}...${CONTRACT.slice(-6)}\``
  );
}

async function buildMAMsg() {
  const PERIODS = [5, 10, 15, 20, 25, 50, 100];
  const pair = await fetchPair();
  const price = parseFloat(pair.priceUsd);
  const sym   = pair.baseToken?.symbol || 'TOKEN';

  let ohlcv;
  try {
    ohlcv = await fetchOHLCV(pair.pairAddress, 100);
  } catch (_) {
    ohlcv = [];
  }

  const closes = ohlcv.map(c => parseFloat(c[4]));

  let msg = `📈 *Hareketli Ortalamalar* (${sym} — saatlik mumlar)
`;
  msg += `💰 Güncel: \`$${formatPrice(price)}\`

`;

  for (const p of PERIODS) {
    const avg = ma(closes, p);
    if (avg === null) {
      msg += `⚪ MA${String(p).padEnd(3)} — yetersiz veri (${closes.length}/${p} mum)
`;
    } else {
      const e = changeEmoji(price, avg);
      const d = diffPct(price, avg);
      msg += `${e} MA${String(p).padEnd(3)} \`$${formatPrice(avg)}\`  (${d})
`;
    }
  }

  msg += `
_Veri: ${closes.length} saatlik mum_`;
  return msg;
}

async function buildCycleMsg() {
  const pair  = await fetchPair();
  const price = parseFloat(pair.priceUsd);
  const sym   = pair.baseToken?.symbol || 'TOKEN';

  let daily;
  try {
    daily = await fetchDailyOHLCV(pair.pairAddress, 100);
  } catch (_) {
    daily = [];
  }
  const closes = daily.map(c => parseFloat(c[4]));

  // Döngü tanımları (günlük mumlar)
  const cycles = [
    { label: 'Kısa  (7G)',  days: 7  },
    { label: 'Orta  (14G)', days: 14 },
    { label: 'Uzun  (25G)', days: 25 },
    { label: 'Makro (50G)', days: 50 },
  ];

  let msg = `🔄 *Döngü Ortalamaları* (${sym} — günlük mumlar)
`;
  msg += `💰 Güncel: \`$${formatPrice(price)}\`

`;

  for (const { label, days } of cycles) {
    const avg = ma(closes, days);
    if (avg === null) {
      msg += `⚪ ${label} — yetersiz veri (${closes.length}/${days} gün)
`;
    } else {
      const e = changeEmoji(price, avg);
      const d = diffPct(price, avg);
      msg += `${e} ${label}: \`$${formatPrice(avg)}\`  (${d})
`;
    }
  }

  // ATH / ATL yaklaşık
  if (closes.length) {
    const ath = Math.max(...closes, price);
    const atl = Math.min(...closes.filter(x => x > 0), price);
    const athPct = (((price - ath) / ath) * 100).toFixed(1);
    const atlPct = (((price - atl) / atl) * 100).toFixed(1);
    msg += `
📌 ATH (${closes.length}G): \`$${formatPrice(ath)}\`  (${athPct}%)
`;
    msg += `📌 ATL (${closes.length}G): \`$${formatPrice(atl)}\`  (+${atlPct}%)
`;
  }

  msg += `
_Veri: ${closes.length} günlük mum_`;
  return msg;
}

async function buildFullMsg() {
  const PERIODS = [5, 10, 15, 20, 25, 50, 100];
  const pair  = await fetchPair();
  const price = parseFloat(pair.priceUsd);
  const sym   = pair.baseToken?.symbol || 'TOKEN';
  const name  = pair.baseToken?.name   || sym;

  // fiyat değişimleri
  const c1h  = pair.priceChange?.h1  || 0;
  const c24h = pair.priceChange?.h24 || 0;
  const vol  = pair.volume?.h24 || 0;
  const liq  = pair.liquidity?.usd || 0;

  // OHLCV
  let hourlyCloses = [], dailyCloses = [];
  try {
    const h = await fetchOHLCV(pair.pairAddress, 100);
    hourlyCloses = h.map(c => parseFloat(c[4]));
  } catch (_) {}
  try {
    const d = await fetchDailyOHLCV(pair.pairAddress, 100);
    dailyCloses = d.map(c => parseFloat(c[4]));
  } catch (_) {}

  // MA'lar
  let maLines = '';
  for (const p of PERIODS) {
    const avg = ma(hourlyCloses, p);
    if (avg !== null) {
      const e = changeEmoji(price, avg);
      maLines += `${e} MA${String(p).padEnd(3)} \`$${formatPrice(avg)}\`  (${diffPct(price, avg)})
`;
    } else {
      maLines += `⚪ MA${p} — yetersiz veri
`;
    }
  }

  // Döngüler
  const cycles = [
    { label: 'Kısa  7G',  days: 7  },
    { label: 'Orta  14G', days: 14 },
    { label: 'Uzun  25G', days: 25 },
    { label: 'Makro 50G', days: 50 },
  ];
  let cycleLines = '';
  for (const { label, days } of cycles) {
    const avg = ma(dailyCloses, days);
    if (avg !== null) {
      const e = changeEmoji(price, avg);
      cycleLines += `${e} ${label}: \`$${formatPrice(avg)}\`  (${diffPct(price, avg)})
`;
    } else {
      cycleLines += `⚪ ${label} — yetersiz veri
`;
    }
  }

  return (
    `💎 *${name}* (\`${sym}\`)

` +
    `💰 *Fiyat:* \`$${formatPrice(price)}\`
` +
    `${c1h  >= 0 ? '🟢' : '🔴'} 1s: ${c1h  >= 0 ? '+' : ''}${c1h.toFixed(2)}%   ` +
    `${c24h >= 0 ? '🟢' : '🔴'} 24s: ${c24h >= 0 ? '+' : ''}${c24h.toFixed(2)}%

` +
    `🛒 *$1 →* ${tokenAmount(price, 1)} ${sym}   |   *$5 →* ${tokenAmount(price, 5)} ${sym}

` +
    `📊 Hacim: $${fmt(vol)}   💧 Liq: $${fmt(liq)}

` +
    `────────────────────
` +
    `📈 *Hareketli Ortalamalar (saatlik)*
` +
    `${maLines}
` +
    `🔄 *Döngü Ortalamaları (günlük)*
` +
    `${cycleLines}
` +
    `📝 \`${CONTRACT}\``
  );
}

// ------ Telegram Komutları ------

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const pair = await fetchPair();
    const sym  = pair.baseToken?.symbol || 'TOKEN';
    await bot.sendMessage(chatId,
      `🤖 *Token Tracker Bot*

` +
      `📍 *Token:* ${sym}
` +
      `📝 \`${CONTRACT}\`

` +
      `📋 *Komutlar:*
` +
      `/fiyat  — Anlık fiyat & $1/$5 alım değerleri
` +
      `/ort    — Hareketli ortalamalar (MA5…MA100)
` +
      `/dongu  — Döngü ortalamaları (7G / 14G / 25G / 50G)
` +
      `/tum    — Tüm veriler tek mesajda`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    bot.sendMessage(chatId, `⚠️ Başlatılamadı: ${err.message}`);
  }
});

bot.onText(/\/fiyat/, async (msg) => {
  const chatId = msg.chat.id;
  const loading = await bot.sendMessage(chatId, '⏳ Fiyat alınıyor…');
  try {
    const text = await buildPriceMsg();
    await bot.editMessageText(text, {
      chat_id: chatId, message_id: loading.message_id, parse_mode: 'Markdown'
    });
  } catch (err) {
    bot.editMessageText(`⚠️ Hata: ${err.message}`, {
      chat_id: chatId, message_id: loading.message_id
    });
  }
});

bot.onText(/\/ort/, async (msg) => {
  const chatId = msg.chat.id;
  const loading = await bot.sendMessage(chatId, '⏳ Ortalamalar hesaplanıyor…');
  try {
    const text = await buildMAMsg();
    await bot.editMessageText(text, {
      chat_id: chatId, message_id: loading.message_id, parse_mode: 'Markdown'
    });
  } catch (err) {
    bot.editMessageText(`⚠️ Hata: ${err.message}`, {
      chat_id: chatId, message_id: loading.message_id
    });
  }
});

bot.onText(/\/dongu/, async (msg) => {
  const chatId = msg.chat.id;
  const loading = await bot.sendMessage(chatId, '⏳ Döngü hesaplanıyor…');
  try {
    const text = await buildCycleMsg();
    await bot.editMessageText(text, {
      chat_id: chatId, message_id: loading.message_id, parse_mode: 'Markdown'
    });
  } catch (err) {
    bot.editMessageText(`⚠️ Hata: ${err.message}`, {
      chat_id: chatId, message_id: loading.message_id
    });
  }
});

bot.onText(/\/tum/, async (msg) => {
  const chatId = msg.chat.id;
  const loading = await bot.sendMessage(chatId, '⏳ Tüm veriler alınıyor…');
  try {
    const text = await buildFullMsg();
    await bot.editMessageText(text, {
      chat_id: chatId, message_id: loading.message_id, parse_mode: 'Markdown'
    });
  } catch (err) {
    bot.editMessageText(`⚠️ Hata: ${err.message}`, {
      chat_id: chatId, message_id: loading.message_id
    });
  }
});

bot.on('polling_error', (err) => console.error('[polling]', err.message));

console.log('🤖 Token Tracker Bot başlatıldı!');
console.log(`📍 Contract : ${CONTRACT}`);
console.log(`🌐 Network  : ${NETWORK}`);
console.log('Komutlar   : /start /fiyat /ort /dongu /tum');
