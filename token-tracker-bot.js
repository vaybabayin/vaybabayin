require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TELEGRAM_TOKEN) { console.error('TELEGRAM_BOT_TOKEN eksik!'); process.exit(1); }

const CONTRACT = (process.env.TOKEN_CONTRACT || '0xAe5F595803B2AA4D07aF8b392e535876a974a296').toLowerCase();

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// Cache
let pairCache      = null;
let priceCacheTime = 0;
let ohlcvHourly    = [];
let ohlcvHourlyAt  = 0;
const PRICE_TTL = 20_000;
const OHLCV_TTL = 60_000;

const http = axios.create({
  timeout: 15_000,
  headers: { Accept: 'application/json' },
});

// ── 1. GeckoTerminal: token adresinden pool bul ──────────────────────────────
const GT_NETWORKS = [
  'base', 'eth', 'bsc', 'arbitrum', 'polygon', 'optimism',
  'solana', 'avax', 'fantom', 'cronos',
];

async function gtFindPool() {
  for (const net of GT_NETWORKS) {
    try {
      const res = await http.get(
        `https://api.geckoterminal.com/api/v2/networks/${net}/tokens/${CONTRACT}/pools?page=1`,
        { headers: { Accept: 'application/json;version=20230302' } }
      );
      const pools = res.data?.data || [];
      if (!pools.length) continue;

      // En yüksek likiditeye sahip pool
      const pool = pools.sort((a, b) =>
        (b.attributes?.reserve_in_usd || 0) - (a.attributes?.reserve_in_usd || 0)
      )[0];

      const attr        = pool.attributes;
      const baseToken   = attr.name?.split(' / ')[0] || 'TOKEN';
      const pairAddress = attr.address;
      const priceUsd    = parseFloat(attr.base_token_price_usd || 0);
      const liqUsd      = parseFloat(attr.reserve_in_usd       || 0);
      const vol24h      = parseFloat(attr.volume_usd?.h24      || 0);
      const fdv         = parseFloat(attr.fdv_usd              || 0);
      const c1h         = parseFloat(attr.price_change_percentage?.h1  || 0);
      const c6h         = parseFloat(attr.price_change_percentage?.h6  || 0);
      const c24h        = parseFloat(attr.price_change_percentage?.h24 || 0);
      const txBuys      = attr.transactions?.h24?.buys  || 0;
      const txSells     = attr.transactions?.h24?.sells || 0;

      console.log(`[GT] network=${net} pool=${pairAddress} price=$${priceUsd} liq=$${liqUsd}`);
      return { net, pairAddress, baseToken, priceUsd, liqUsd, vol24h, fdv, c1h, c6h, c24h, txBuys, txSells };
    } catch (e) {
      console.warn(`[GT] ${net} hata: ${e.message}`);
    }
  }
  return null;
}

// ── 2. DexScreener: yedek kaynak ────────────────────────────────────────────
const DS_CHAIN_MAP = { eth: 'ethereum', bsc: 'bsc', base: 'base', arbitrum: 'arbitrum', polygon: 'polygon' };

async function dsFindPool() {
  const res = await http.get(`https://api.dexscreener.com/latest/dex/tokens/${CONTRACT}`);
  const pairs = res.data?.pairs || [];
  if (!pairs.length) return null;
  const p    = pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
  const net  = DS_CHAIN_MAP[p.chainId] || p.chainId;
  console.log(`[DS] chainId=${p.chainId} pair=${p.pairAddress} liq=$${p.liquidity?.usd}`);
  return {
    net,
    pairAddress: p.pairAddress,
    baseToken:   p.baseToken?.symbol || 'TOKEN',
    priceUsd:    parseFloat(p.priceUsd  || 0),
    liqUsd:      parseFloat(p.liquidity?.usd || 0),
    vol24h:      parseFloat(p.volume?.h24    || 0),
    fdv:         parseFloat(p.fdv            || 0),
    c1h:         p.priceChange?.h1  || 0,
    c6h:         p.priceChange?.h6  || 0,
    c24h:        p.priceChange?.h24 || 0,
    txBuys:      p.txns?.h24?.buys  || 0,
    txSells:     p.txns?.h24?.sells || 0,
  };
}

async function fetchPair() {
  const now = Date.now();
  if (pairCache && now - priceCacheTime < PRICE_TTL) return pairCache;

  let pair = await gtFindPool().catch(() => null);
  if (!pair) pair = await dsFindPool().catch(() => null);
  if (!pair) throw new Error(
    `Token bulunamadı.\nContract: \`${CONTRACT}\`\nDexScreener ve GeckoTerminal'de pair yok.`
  );

  pairCache      = pair;
  priceCacheTime = now;
  return pair;
}

// ── OHLCV ───────────────────────────────────────────────────────────────────
async function fetchOHLCV(net, pairAddress, tf = 'hour', limit = 100) {
  if (tf === 'hour' && ohlcvHourly.length && Date.now() - ohlcvHourlyAt < OHLCV_TTL) return ohlcvHourly;
  const url = `https://api.geckoterminal.com/api/v2/networks/${net}/pools/${pairAddress}/ohlcv/${tf}?limit=${limit}`;
  const res = await http.get(url, { headers: { Accept: 'application/json;version=20230302' } });
  const list = (res.data?.data?.attributes?.ohlcv_list || []).reverse();
  if (tf === 'hour') { ohlcvHourly = list; ohlcvHourlyAt = Date.now(); }
  return list;
}

// ── Yardımcılar ─────────────────────────────────────────────────────────────
function ma(closes, p) {
  if (closes.length < p) return null;
  const sl = closes.slice(-p);
  return sl.reduce((s, v) => s + v, 0) / p;
}

function fp(p) {
  if (!p || isNaN(p)) return 'N/A';
  if (p < 0.000001) return p.toExponential(4);
  if (p < 0.0001)   return p.toFixed(9);
  if (p < 0.01)     return p.toFixed(7);
  if (p < 1)        return p.toFixed(6);
  return p.toFixed(4);
}

function fmt(n, d = 2) {
  if (!n || isNaN(n)) return 'N/A';
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: d });
}

function ta(price, dollars) {
  if (!price) return 'N/A';
  const amt = dollars / price;
  if (amt >= 1e6) return fmt(amt / 1e6, 2) + 'M';
  if (amt >= 1e3) return fmt(amt / 1e3, 2) + 'K';
  return fmt(amt, 0);
}

function dp(cur, ref) {
  if (!ref) return '?';
  const d = ((cur - ref) / ref) * 100;
  return (d >= 0 ? '+' : '') + d.toFixed(2) + '%';
}

const ar = (c, r) => c >= r ? '🟢' : '🔴';

// ── Mesaj oluşturucular ──────────────────────────────────────────────────────
async function buildPriceMsg() {
  const p = await fetchPair();
  const sign = (v) => v >= 0 ? '+' : '';
  return (
    `💎 *${p.baseToken}* — ${p.net.toUpperCase()}\n\n` +
    `💰 *Fiyat:* \`$${fp(p.priceUsd)}\`\n` +
    `${p.c1h  >= 0 ? '🟢' : '🔴'}  1s: ${sign(p.c1h)}${Number(p.c1h).toFixed(2)}%\n` +
    `${p.c6h  >= 0 ? '🟢' : '🔴'}  6s: ${sign(p.c6h)}${Number(p.c6h).toFixed(2)}%\n` +
    `${p.c24h >= 0 ? '🟢' : '🔴'} 24s: ${sign(p.c24h)}${Number(p.c24h).toFixed(2)}%\n\n` +
    `🛒 *$1  →* ${ta(p.priceUsd, 1)} ${p.baseToken}\n` +
    `🛒 *$5  →* ${ta(p.priceUsd, 5)} ${p.baseToken}\n\n` +
    `📊 Hacim (24s): $${fmt(p.vol24h)}\n` +
    `💧 Likidite:    $${fmt(p.liqUsd)}\n` +
    `🏦 FDV:         $${fmt(p.fdv)}\n` +
    `🔄 TX (24s):    ${fmt(p.txBuys + p.txSells, 0)}\n\n` +
    `📝 \`${CONTRACT}\``
  );
}

async function buildMAMsg() {
  const PERIODS = [5, 10, 15, 20, 25, 50, 100];
  const p = await fetchPair();
  let closes = [];
  try { closes = (await fetchOHLCV(p.net, p.pairAddress, 'hour', 100)).map(c => parseFloat(c[4])); } catch (_) {}
  let msg = `📈 *Hareketli Ortalamalar* (${p.baseToken} — saatlik)\n💰 Güncel: \`$${fp(p.priceUsd)}\`\n\n`;
  for (const per of PERIODS) {
    const avg = ma(closes, per);
    msg += avg === null
      ? `⚪ MA${String(per).padEnd(3)} — yetersiz veri (${closes.length}/${per})\n`
      : `${ar(p.priceUsd, avg)} MA${String(per).padEnd(3)} \`$${fp(avg)}\`  (${dp(p.priceUsd, avg)})\n`;
  }
  return msg + `\n_Veri: ${closes.length} saatlik mum_`;
}

async function buildCycleMsg() {
  const p = await fetchPair();
  let closes = [];
  try { closes = (await fetchOHLCV(p.net, p.pairAddress, 'day', 100)).map(c => parseFloat(c[4])); } catch (_) {}
  const cycles = [
    { label: 'Kısa  (7G)',  days: 7  },
    { label: 'Orta  (14G)', days: 14 },
    { label: 'Uzun  (25G)', days: 25 },
    { label: 'Makro (50G)', days: 50 },
  ];
  let msg = `🔄 *Döngü Ortalamaları* (${p.baseToken} — günlük)\n💰 Güncel: \`$${fp(p.priceUsd)}\`\n\n`;
  for (const { label, days } of cycles) {
    const avg = ma(closes, days);
    msg += avg === null
      ? `⚪ ${label} — yetersiz veri (${closes.length}/${days}G)\n`
      : `${ar(p.priceUsd, avg)} ${label}: \`$${fp(avg)}\`  (${dp(p.priceUsd, avg)})\n`;
  }
  if (closes.length) {
    const ath = Math.max(...closes, p.priceUsd);
    const atl = Math.min(...closes.filter(x => x > 0), p.priceUsd);
    msg += `\n📌 ATH (${closes.length}G): \`$${fp(ath)}\`  (${dp(p.priceUsd, ath)})\n`;
    msg += `📌 ATL (${closes.length}G): \`$${fp(atl)}\`  (${dp(p.priceUsd, atl)})\n`;
  }
  return msg + `\n_Veri: ${closes.length} günlük mum_`;
}

async function buildFullMsg() {
  const PERIODS = [5, 10, 15, 20, 25, 50, 100];
  const p = await fetchPair();
  let hC = [], dC = [];
  try { hC = (await fetchOHLCV(p.net, p.pairAddress, 'hour', 100)).map(c => parseFloat(c[4])); } catch (_) {}
  try { dC = (await fetchOHLCV(p.net, p.pairAddress, 'day',  100)).map(c => parseFloat(c[4])); } catch (_) {}
  const sign = (v) => v >= 0 ? '+' : '';
  let maL = '';
  for (const per of PERIODS) {
    const avg = ma(hC, per);
    maL += avg !== null
      ? `${ar(p.priceUsd, avg)} MA${String(per).padEnd(3)} \`$${fp(avg)}\`  (${dp(p.priceUsd, avg)})\n`
      : `⚪ MA${per} — yetersiz veri\n`;
  }
  let cyL = '';
  for (const { label, days } of [{label:'Kısa  7G',days:7},{label:'Orta  14G',days:14},{label:'Uzun  25G',days:25},{label:'Makro 50G',days:50}]) {
    const avg = ma(dC, days);
    cyL += avg !== null
      ? `${ar(p.priceUsd, avg)} ${label}: \`$${fp(avg)}\`  (${dp(p.priceUsd, avg)})\n`
      : `⚪ ${label} — yetersiz veri\n`;
  }
  return (
    `💎 *${p.baseToken}* — ${p.net.toUpperCase()}\n\n` +
    `💰 *Fiyat:* \`$${fp(p.priceUsd)}\`\n` +
    `${p.c1h>=0?'🟢':'🔴'} 1s: ${sign(p.c1h)}${Number(p.c1h).toFixed(2)}%   ` +
    `${p.c24h>=0?'🟢':'🔴'} 24s: ${sign(p.c24h)}${Number(p.c24h).toFixed(2)}%\n\n` +
    `🛒 *$1→* ${ta(p.priceUsd,1)} ${p.baseToken}   |   *$5→* ${ta(p.priceUsd,5)} ${p.baseToken}\n` +
    `📊 Hacim: $${fmt(p.vol24h)}   💧 Liq: $${fmt(p.liqUsd)}\n\n` +
    `────────────────────\n` +
    `📈 *Hareketli Ortalamalar (saatlik)*\n${maL}\n` +
    `🔄 *Döngü Ortalamaları (günlük)*\n${cyL}\n` +
    `📝 \`${CONTRACT}\``
  );
}

// ── Komutlar ─────────────────────────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const p = await fetchPair();
    await bot.sendMessage(chatId,
      `🤖 *Token Tracker Bot*\n\n📍 *Token:* ${p.baseToken} (${p.net.toUpperCase()})\n📝 \`${CONTRACT}\`\n\n📋 *Komutlar:*\n/fiyat  — Anlık fiyat & $1/$5 alım değerleri\n/ort    — Hareketli ortalamalar (MA5…MA100)\n/dongu  — Döngü ortalamaları (7G/14G/25G/50G)\n/tum    — Tüm veriler tek mesajda`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) { bot.sendMessage(chatId, `⚠️ Başlatılamadı:\n${err.message}`); }
});

bot.onText(/\/fiyat/, async (msg) => {
  const chatId = msg.chat.id;
  const l = await bot.sendMessage(chatId, '⏳ Fiyat alınıyor…');
  try { await bot.editMessageText(await buildPriceMsg(), { chat_id: chatId, message_id: l.message_id, parse_mode: 'Markdown' }); }
  catch (err) { bot.editMessageText(`⚠️ ${err.message}`, { chat_id: chatId, message_id: l.message_id }); }
});

bot.onText(/\/ort/, async (msg) => {
  const chatId = msg.chat.id;
  const l = await bot.sendMessage(chatId, '⏳ Ortalamalar hesaplanıyor…');
  try { await bot.editMessageText(await buildMAMsg(), { chat_id: chatId, message_id: l.message_id, parse_mode: 'Markdown' }); }
  catch (err) { bot.editMessageText(`⚠️ ${err.message}`, { chat_id: chatId, message_id: l.message_id }); }
});

bot.onText(/\/dongu/, async (msg) => {
  const chatId = msg.chat.id;
  const l = await bot.sendMessage(chatId, '⏳ Döngü hesaplanıyor…');
  try { await bot.editMessageText(await buildCycleMsg(), { chat_id: chatId, message_id: l.message_id, parse_mode: 'Markdown' }); }
  catch (err) { bot.editMessageText(`⚠️ ${err.message}`, { chat_id: chatId, message_id: l.message_id }); }
});

bot.onText(/\/tum/, async (msg) => {
  const chatId = msg.chat.id;
  const l = await bot.sendMessage(chatId, '⏳ Tüm veriler alınıyor…');
  try { await bot.editMessageText(await buildFullMsg(), { chat_id: chatId, message_id: l.message_id, parse_mode: 'Markdown' }); }
  catch (err) { bot.editMessageText(`⚠️ ${err.message}`, { chat_id: chatId, message_id: l.message_id }); }
});

bot.on('polling_error', (err) => console.error('[polling]', err.message));

console.log('🤖 Token Tracker Bot başlatıldı!');
console.log(`📍 Contract : ${CONTRACT}`);
console.log(`🔍 Taranacak ağlar: ${GT_NETWORKS.join(', ')}`);
