require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

const VERSION = 'v4';

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TELEGRAM_TOKEN) { console.error('TELEGRAM_BOT_TOKEN eksik!'); process.exit(1); }

const CONTRACT = (process.env.TOKEN_CONTRACT || '0xAe5F595803B2AA4D07aF8b392e535876a974a296').toLowerCase();

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

let pairCache = null, priceCacheTime = 0;
let ohlcvHourly = [], ohlcvHourlyAt = 0;
const PRICE_TTL = 20_000, OHLCV_TTL = 60_000;

const http = axios.create({ timeout: 15_000 });

const GT_NETWORKS = ['base','eth','bsc','arbitrum','polygon','optimism','avax','fantom','cronos'];

async function gtFindPool() {
  for (const net of GT_NETWORKS) {
    try {
      const res = await http.get(
        `https://api.geckoterminal.com/api/v2/networks/${net}/tokens/${CONTRACT}/pools?page=1`,
        { headers: { Accept: 'application/json;version=20230302' } }
      );
      const pools = res.data?.data || [];
      if (!pools.length) { console.log(`[GT] ${net}: pool yok`); continue; }
      const pool = pools.sort((a,b) => (b.attributes?.reserve_in_usd||0)-(a.attributes?.reserve_in_usd||0))[0];
      const attr = pool.attributes;
      console.log(`[GT] BULUNDU: ${net} pool=${attr.address} price=${attr.base_token_price_usd}`);
      return {
        net, pairAddress: attr.address,
        baseToken: attr.name?.split(' / ')[0] || 'TOKEN',
        priceUsd: parseFloat(attr.base_token_price_usd||0),
        liqUsd:   parseFloat(attr.reserve_in_usd||0),
        vol24h:   parseFloat(attr.volume_usd?.h24||0),
        fdv:      parseFloat(attr.fdv_usd||0),
        c1h:  parseFloat(attr.price_change_percentage?.h1||0),
        c6h:  parseFloat(attr.price_change_percentage?.h6||0),
        c24h: parseFloat(attr.price_change_percentage?.h24||0),
        txBuys:  attr.transactions?.h24?.buys||0,
        txSells: attr.transactions?.h24?.sells||0,
      };
    } catch(e) { console.log(`[GT] ${net}: hata - ${e.message}`); }
  }
  return null;
}

async function dsFindPool() {
  const res = await http.get(`https://api.dexscreener.com/latest/dex/tokens/${CONTRACT}`);
  const pairs = res.data?.pairs || [];
  if (!pairs.length) { console.log('[DS] pair yok'); return null; }
  const p = pairs.sort((a,b)=>(b.liquidity?.usd||0)-(a.liquidity?.usd||0))[0];
  const chainMap = {ethereum:'eth',bsc:'bsc',base:'base',arbitrum:'arbitrum',polygon:'polygon'};
  const net = chainMap[p.chainId] || p.chainId;
  console.log(`[DS] BULUNDU: ${p.chainId} pair=${p.pairAddress}`);
  return {
    net, pairAddress: p.pairAddress,
    baseToken: p.baseToken?.symbol||'TOKEN',
    priceUsd: parseFloat(p.priceUsd||0),
    liqUsd:   parseFloat(p.liquidity?.usd||0),
    vol24h:   parseFloat(p.volume?.h24||0),
    fdv:      parseFloat(p.fdv||0),
    c1h: p.priceChange?.h1||0, c6h: p.priceChange?.h6||0, c24h: p.priceChange?.h24||0,
    txBuys: p.txns?.h24?.buys||0, txSells: p.txns?.h24?.sells||0,
  };
}

async function fetchPair() {
  const now = Date.now();
  if (pairCache && now - priceCacheTime < PRICE_TTL) return pairCache;
  let pair = await gtFindPool().catch(e => { console.log('[GT] catch:',e.message); return null; });
  if (!pair) pair = await dsFindPool().catch(e => { console.log('[DS] catch:',e.message); return null; });
  if (!pair) throw new Error(`[${VERSION}] Hiçbir DEX'te pair bulunamadı.\nContract: ${CONTRACT}`);
  pairCache = pair; priceCacheTime = now;
  return pair;
}

async function fetchOHLCV(net, pairAddress, tf='hour', limit=100) {
  if (tf==='hour' && ohlcvHourly.length && Date.now()-ohlcvHourlyAt < OHLCV_TTL) return ohlcvHourly;
  const res = await http.get(
    `https://api.geckoterminal.com/api/v2/networks/${net}/pools/${pairAddress}/ohlcv/${tf}?limit=${limit}`,
    { headers: { Accept: 'application/json;version=20230302' } }
  );
  const list = (res.data?.data?.attributes?.ohlcv_list||[]).reverse();
  if (tf==='hour') { ohlcvHourly=list; ohlcvHourlyAt=Date.now(); }
  return list;
}

function ma(closes,p) {
  if (closes.length<p) return null;
  return closes.slice(-p).reduce((s,v)=>s+v,0)/p;
}
function fp(p) {
  if (!p||isNaN(p)) return 'N/A';
  if (p<0.000001) return p.toExponential(4);
  if (p<0.0001)   return p.toFixed(9);
  if (p<0.01)     return p.toFixed(7);
  if (p<1)        return p.toFixed(6);
  return p.toFixed(4);
}
function fmt(n,d=2) {
  if (!n||isNaN(n)) return 'N/A';
  return Number(n).toLocaleString('en-US',{maximumFractionDigits:d});
}
function ta(price,dollars) {
  if (!price) return 'N/A';
  const amt=dollars/price;
  if (amt>=1e6) return fmt(amt/1e6,2)+'M';
  if (amt>=1e3) return fmt(amt/1e3,2)+'K';
  return fmt(amt,0);
}
function dp(cur,ref) {
  if (!ref) return '?';
  const d=((cur-ref)/ref)*100;
  return (d>=0?'+':'')+d.toFixed(2)+'%';
}
const ar=(c,r)=>c>=r?'🟢':'🔴';

async function buildPriceMsg() {
  const p=await fetchPair();
  const s=v=>v>=0?'+':'';
  return `💎 *${p.baseToken}* — ${p.net.toUpperCase()}\n\n💰 *Fiyat:* \`$${fp(p.priceUsd)}\`\n${p.c1h>=0?'🟢':'🔴'}  1s: ${s(p.c1h)}${Number(p.c1h).toFixed(2)}%\n${p.c6h>=0?'🟢':'🔴'}  6s: ${s(p.c6h)}${Number(p.c6h).toFixed(2)}%\n${p.c24h>=0?'🟢':'🔴'} 24s: ${s(p.c24h)}${Number(p.c24h).toFixed(2)}%\n\n🛒 *$1  →* ${ta(p.priceUsd,1)} ${p.baseToken}\n🛒 *$5  →* ${ta(p.priceUsd,5)} ${p.baseToken}\n\n📊 Hacim: $${fmt(p.vol24h)}\n💧 Liq: $${fmt(p.liqUsd)}\n🏦 FDV: $${fmt(p.fdv)}\n🔄 TX: ${fmt(p.txBuys+p.txSells,0)}\n\n📝 \`${CONTRACT}\``;
}

async function buildMAMsg() {
  const PERIODS=[5,10,15,20,25,50,100];
  const p=await fetchPair();
  let closes=[];
  try { closes=(await fetchOHLCV(p.net,p.pairAddress,'hour',100)).map(c=>parseFloat(c[4])); } catch(_){}
  let msg=`📈 *Hareketli Ortalamalar* (${p.baseToken} — saatlik)\n💰 Güncel: \`$${fp(p.priceUsd)}\`\n\n`;
  for (const per of PERIODS) {
    const avg=ma(closes,per);
    msg+=avg===null?`⚪ MA${String(per).padEnd(3)} — yetersiz veri\n`:`${ar(p.priceUsd,avg)} MA${String(per).padEnd(3)} \`$${fp(avg)}\`  (${dp(p.priceUsd,avg)})\n`;
  }
  return msg+`\n_Veri: ${closes.length} saatlik mum_`;
}

async function buildCycleMsg() {
  const p=await fetchPair();
  let closes=[];
  try { closes=(await fetchOHLCV(p.net,p.pairAddress,'day',100)).map(c=>parseFloat(c[4])); } catch(_){}
  const cycles=[{label:'Kısa  (7G)',days:7},{label:'Orta  (14G)',days:14},{label:'Uzun  (25G)',days:25},{label:'Makro (50G)',days:50}];
  let msg=`🔄 *Döngü Ortalamaları* (${p.baseToken} — günlük)\n💰 Güncel: \`$${fp(p.priceUsd)}\`\n\n`;
  for (const {label,days} of cycles) {
    const avg=ma(closes,days);
    msg+=avg===null?`⚪ ${label} — yetersiz veri\n`:`${ar(p.priceUsd,avg)} ${label}: \`$${fp(avg)}\`  (${dp(p.priceUsd,avg)})\n`;
  }
  if (closes.length) {
    const ath=Math.max(...closes,p.priceUsd), atl=Math.min(...closes.filter(x=>x>0),p.priceUsd);
    msg+=`\n📌 ATH: \`$${fp(ath)}\`  (${dp(p.priceUsd,ath)})\n📌 ATL: \`$${fp(atl)}\`  (${dp(p.priceUsd,atl)})\n`;
  }
  return msg+`\n_Veri: ${closes.length} günlük mum_`;
}

async function buildFullMsg() {
  const PERIODS=[5,10,15,20,25,50,100];
  const p=await fetchPair();
  let hC=[],dC=[];
  try { hC=(await fetchOHLCV(p.net,p.pairAddress,'hour',100)).map(c=>parseFloat(c[4])); } catch(_){}
  try { dC=(await fetchOHLCV(p.net,p.pairAddress,'day',100)).map(c=>parseFloat(c[4])); } catch(_){}
  const s=v=>v>=0?'+':'';
  let maL=''; for(const per of PERIODS){const avg=ma(hC,per);maL+=avg!==null?`${ar(p.priceUsd,avg)} MA${String(per).padEnd(3)} \`$${fp(avg)}\`  (${dp(p.priceUsd,avg)})\n`:`⚪ MA${per} — yetersiz veri\n`;}
  let cyL=''; for(const {label,days} of [{label:'Kısa 7G',days:7},{label:'Orta 14G',days:14},{label:'Uzun 25G',days:25},{label:'Makro 50G',days:50}]){const avg=ma(dC,days);cyL+=avg!==null?`${ar(p.priceUsd,avg)} ${label}: \`$${fp(avg)}\`  (${dp(p.priceUsd,avg)})\n`:`⚪ ${label} — yetersiz veri\n`;}
  return `💎 *${p.baseToken}* — ${p.net.toUpperCase()}\n\n💰 *Fiyat:* \`$${fp(p.priceUsd)}\`\n${p.c1h>=0?'🟢':'🔴'} 1s: ${s(p.c1h)}${Number(p.c1h).toFixed(2)}%   ${p.c24h>=0?'🟢':'🔴'} 24s: ${s(p.c24h)}${Number(p.c24h).toFixed(2)}%\n\n🛒 *$1→* ${ta(p.priceUsd,1)} ${p.baseToken}   |   *$5→* ${ta(p.priceUsd,5)} ${p.baseToken}\n📊 Hacim: $${fmt(p.vol24h)}   💧 Liq: $${fmt(p.liqUsd)}\n\n────────────────────\n📈 *Hareketli Ortalamalar*\n${maL}\n🔄 *Döngü Ortalamaları*\n${cyL}\n📝 \`${CONTRACT}\``;
}

// ── /debug: ham API yanıtlarını göster ───────────────────────────────────────
bot.onText(/\/debug/, async (msg) => {
  const chatId = msg.chat.id;
  const l = await bot.sendMessage(chatId, `⏳ [${VERSION}] Debug çalıştırılıyor…`);
  let out = `🔧 *Debug* \`${VERSION}\`\n📝 \`${CONTRACT}\`\n\n`;

  // GeckoTerminal — base dene
  for (const net of ['base','eth','bsc','arbitrum']) {
    try {
      const res = await http.get(
        `https://api.geckoterminal.com/api/v2/networks/${net}/tokens/${CONTRACT}/pools?page=1`,
        { headers: { Accept: 'application/json;version=20230302' } }
      );
      const pools = res.data?.data || [];
      out += `🌐 GT/${net}: ${pools.length} pool`;
      if (pools.length) out += ` | liq=$${pools[0].attributes?.reserve_in_usd||0}`;
      out += '\n';
    } catch(e) { out += `🌐 GT/${net}: HATA — ${e.message}\n`; }
  }

  // DexScreener
  try {
    const res = await http.get(`https://api.dexscreener.com/latest/dex/tokens/${CONTRACT}`);
    const pairs = res.data?.pairs || [];
    out += `\n🟡 DS: ${pairs.length} pair`;
    if (pairs.length) out += ` | chain=${pairs[0].chainId} liq=$${pairs[0].liquidity?.usd||0}`;
    out += '\n';
  } catch(e) { out += `\n🟡 DS: HATA — ${e.message}\n`; }

  await bot.editMessageText(out, { chat_id: chatId, message_id: l.message_id, parse_mode: 'Markdown' });
});

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const p = await fetchPair();
    await bot.sendMessage(chatId,
      `🤖 *Token Tracker Bot* \`${VERSION}\`\n\n📍 *Token:* ${p.baseToken} (${p.net.toUpperCase()})\n📝 \`${CONTRACT}\`\n\n📋 *Komutlar:*\n/fiyat — Anlık fiyat & $1/$5 alım\n/ort   — Hareketli ortalamalar (MA5…100)\n/dongu — Döngü ortalamaları\n/tum   — Tüm veriler\n/debug — API tanı (hata ayıklama)`,
      { parse_mode: 'Markdown' }
    );
  } catch(err) { bot.sendMessage(chatId, `⚠️ [${VERSION}] ${err.message}`); }
});

bot.onText(/\/fiyat/, async (msg) => {
  const chatId=msg.chat.id, l=await bot.sendMessage(chatId,'⏳ Fiyat alınıyor…');
  try { await bot.editMessageText(await buildPriceMsg(),{chat_id:chatId,message_id:l.message_id,parse_mode:'Markdown'}); }
  catch(err){bot.editMessageText(`⚠️ ${err.message}`,{chat_id:chatId,message_id:l.message_id});}
});

bot.onText(/\/ort/, async (msg) => {
  const chatId=msg.chat.id, l=await bot.sendMessage(chatId,'⏳ Ortalamalar…');
  try { await bot.editMessageText(await buildMAMsg(),{chat_id:chatId,message_id:l.message_id,parse_mode:'Markdown'}); }
  catch(err){bot.editMessageText(`⚠️ ${err.message}`,{chat_id:chatId,message_id:l.message_id});}
});

bot.onText(/\/dongu/, async (msg) => {
  const chatId=msg.chat.id, l=await bot.sendMessage(chatId,'⏳ Döngü…');
  try { await bot.editMessageText(await buildCycleMsg(),{chat_id:chatId,message_id:l.message_id,parse_mode:'Markdown'}); }
  catch(err){bot.editMessageText(`⚠️ ${err.message}`,{chat_id:chatId,message_id:l.message_id});}
});

bot.onText(/\/tum/, async (msg) => {
  const chatId=msg.chat.id, l=await bot.sendMessage(chatId,'⏳ Tüm veriler…');
  try { await bot.editMessageText(await buildFullMsg(),{chat_id:chatId,message_id:l.message_id,parse_mode:'Markdown'}); }
  catch(err){bot.editMessageText(`⚠️ ${err.message}`,{chat_id:chatId,message_id:l.message_id});}
});

bot.on('polling_error', err=>console.error('[polling]',err.message));

console.log(`🤖 Token Tracker Bot ${VERSION} başlatıldı!`);
console.log(`📍 Contract : ${CONTRACT}`);
console.log(`🔍 Ağlar    : ${GT_NETWORKS.join(', ')}`);
