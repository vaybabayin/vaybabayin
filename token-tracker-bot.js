require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { ethers } = require('ethers');
const axios = require('axios');

const VERSION = 'v9.2';
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL_ID    = process.env.TELEGRAM_CHANNEL_ID;
const CONTRACT      = process.env.TOKEN_CONTRACT || '0xAe5F595803B2AA4D07aF8b392e535876a974a296';
const SC1_TARGET    = parseInt(process.env.SC1_TARGET || '200');
const SC5_TARGET    = parseInt(process.env.SC5_TARGET || '100');

if (!TELEGRAM_TOKEN) { console.error('TELEGRAM_BOT_TOKEN eksik!'); process.exit(1); }
if (!CHANNEL_ID) console.warn('[WARN] TELEGRAM_CHANNEL_ID ayarlı değil');

const CONTRACT_LOWER = CONTRACT.toLowerCase();

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
  1: { name: 'opal', emoji: '💎', nominalUsd: 1, target: SC1_TARGET },
  2: { name: 'jade', emoji: '🎱', nominalUsd: 5, target: SC5_TARGET },
};
function getTierInfo(t) {
  return TIER_INFO[t] || { name: `tier${t}`, emoji: '📦', nominalUsd: t, target: 100 };
}

const CLAIM_SELECTORS = new Set([
  '0x4e71d92d', '0x379607f5', '0x1e83409a',
  '0x48c54b9d', '0x2e7ba6ef', '0xbd66528a',
  '0xdb006a75', '0x96c55175', '0xae169a50',
]);

function isClaimInput(data) {
  if (!data || data.length < 10) return false;
  if (CLAIM_SELECTORS.has(data.slice(0, 10).toLowerCase())) return true;
  if (data.length === 330) return true;
  return false;
}

function decodeTier(data) {
  if (!data || data.length !== 330) return null;
  const t = parseInt(data.slice(74, 138), 16);
  return (t >= 1 && t <= 20) ? t : null;
}

const TRANSFER_TOPIC   = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const CHAINLINK_ETHUSD = '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70';
const WETH             = '0x4200000000000000000000000000000000000006';
const USDC             = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const UNI_FACTORY      = '0x33128a8fC17869897dcE68Ed026d694621f6FDfD';
const AERO_FACTORY     = '0x420DD381b31aEf6683db6B902084cB0FFECe40Da';
const CYCLE_SIZE       = 50;

const tierStates = {};
function ts(tier) {
  if (!tierStates[tier])
    tierStates[tier] = { history: [], count: 0, sessionCount: 0, streak: 0, streakDir: null };
  return tierStates[tier];
}

const conversations = {};
let processedTxs = new Set();
let pollingErrCount = 0;
let provider, bot;
let tokenInfoCache = {};
let priceCache = {};
let ethPrice = 0, ethPriceAt = 0;
let lastPollBlock = 0;

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

async function getTokenPriceUsd(address) {
  const k = address.toLowerCase();
  const cached = priceCache[k];
  if (cached && Date.now() - cached.at < 60_000) return cached.price;
  const { decimals } = await getTokenInfo(address);
  const uniFactory = new ethers.Contract(UNI_FACTORY,
    ['function getPool(address,address,uint24) view returns (address)'], provider);
  for (const [quote, qDec, isEth] of [[WETH, 18, true], [USDC, 6, false]]) {
    for (const fee of [100, 500, 3000, 10000]) {
      try {
        const pa = await uniFactory.getPool(address, quote, fee);
        if (!pa || pa === ethers.ZeroAddress) continue;
        const pool = new ethers.Contract(pa, [
          'function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)',
          'function token0() view returns (address)',
        ], provider);
        const [s, t0] = await Promise.all([pool.slot0(), pool.token0()]);
        const isT0 = t0.toLowerCase() === k;
        const sq = Number(s[0]) / 2 ** 96, pr = sq * sq;
        const piq = isT0 ? pr*(10**qDec)/(10**decimals) : (1/pr)*(10**decimals)/(10**qDec);
        const pusd = isEth ? piq * await getEthUsd() : piq;
        if (pusd > 0 && pusd < 1e12) { priceCache[k] = { price: pusd, at: Date.now() }; return pusd; }
      } catch (_) {}
    }
  }
  try {
    const af = new ethers.Contract(AERO_FACTORY,
      ['function getPair(address,address,bool) view returns (address)'], provider);
    for (const [quote, qDec, isEth] of [[WETH, 18, true], [USDC, 6, false]]) {
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
          const pusd = isEth ? (quoR/tokR)*await getEthUsd() : quoR/tokR;
          if (pusd > 0 && pusd < 1e12) { priceCache[k] = { price: pusd, at: Date.now() }; return pusd; }
        } catch (_) {}
      }
    }
  } catch (_) {}
  try {
    const r = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${address}`, { timeout: 8000 });
    const pairs = (r.data?.pairs || []).filter(p => p.chainId === 'base');
    if (pairs.length) {
      const price = parseFloat(pairs[0].priceUsd);
      if (price > 0) { priceCache[k] = { price, at: Date.now() }; return price; }
    }
  } catch (_) {}
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
  if (!CHANNEL_ID) return;
  try {
    await bot.sendMessage(CHANNEL_ID, msg, { parse_mode: 'HTML', disable_web_page_preview: true });
  } catch (e) { console.error('[TG send]', e.message); }
}

async function processClaimTx(txHash, from, data, blockNum, blockTs) {
  if (processedTxs.has(txHash)) return;
  processedTxs.add(txHash);
  if (processedTxs.size > 20000) {
    const arr = [...processedTxs]; processedTxs = new Set(arr.slice(-10000));
  }

  let receipt;
  try { receipt = await provider.getTransactionReceipt(txHash); } catch (_) { return; }
  if (!receipt || receipt.status === 0) return;

  const claimer = from.toLowerCase();

  // Only accept ERC20 transfers where:
  //   (a) the token contract IS our scratch card contract, OR
  //   (b) the transfer is FROM our scratch card contract
  // This filters out WETH swaps, DEX router transfers, etc. in the same TX.
  const received = {};
  for (const log of receipt.logs) {
    if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
    if (log.topics.length < 3) continue;
    const to       = ('0x' + log.topics[2].slice(26)).toLowerCase();
    const fromLog  = ('0x' + log.topics[1].slice(26)).toLowerCase();
    const tokenAddr = log.address.toLowerCase();
    if (to !== claimer) continue;
    if (tokenAddr !== CONTRACT_LOWER && fromLog !== CONTRACT_LOWER) continue; // skip unrelated
    const amount = BigInt(log.data);
    received[tokenAddr] = (received[tokenAddr] ?? 0n) + amount;
  }

  if (!Object.keys(received).length) {
    // Fallback: accept any transfer TO claimer (older behaviour) only if no contract-filtered result
    for (const log of receipt.logs) {
      if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
      if (log.topics.length < 3) continue;
      const to = ('0x' + log.topics[2].slice(26)).toLowerCase();
      if (to !== claimer) continue;
      const tokenAddr = log.address.toLowerCase();
      const amount = BigInt(log.data);
      received[tokenAddr] = (received[tokenAddr] ?? 0n) + amount;
    }
  }

  if (!Object.keys(received).length) return;

  let bestUsd = 0, bestToken = null;
  for (const [addr, rawAmt] of Object.entries(received)) {
    try {
      const info  = await getTokenInfo(addr);
      const human = Number(ethers.formatUnits(rawAmt, info.decimals));
      const price = await getTokenPriceUsd(addr);
      if (!price) { console.log(`[NO PRICE] ${info.symbol || addr.slice(0,10)}`); continue; }
      const usd = human * price;
      console.log(`[TOKEN] ${info.symbol} amt=${human.toFixed(4)} price=$${price.toExponential(3)} => $${usd.toFixed(4)}`);
      if (usd > bestUsd) { bestUsd = usd; bestToken = { addr, ...info, price }; }
    } catch (_) {}
  }

  if (!bestToken || bestUsd <= 0) return;

  const tier     = decodeTier(data) ?? (bestUsd >= 2.5 ? 2 : 1);
  const tierInfo = getTierInfo(tier);
  const state    = ts(tier);

  if (state.history.length > 0) {
    const dir = bestUsd >= state.history[0].usd ? 'up' : 'down';
    state.streak    = dir === state.streakDir ? state.streak + 1 : 1;
    state.streakDir = dir;
  } else {
    state.streak = 1; state.streakDir = null;
  }

  state.count++;
  state.sessionCount++;
  state.history.unshift({ usd: bestUsd, ts: blockTs * 1000, hash: txHash, claimer: from });
  if (state.history.length > 200) state.history.pop();

  const date  = new Date(blockTs * 1000).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
  const txUrl = `https://basescan.org/tx/${txHash}`;

  if (TIER_INFO[tier]) {
    const posInCycle = ((state.count - 1) % CYCLE_SIZE) + 1;
    const remaining  = CYCLE_SIZE - posInCycle;
    const cycleAvg   = state.history.slice(0, posInCycle).reduce((s, c) => s + c.usd, 0) / posInCycle;
    const avgLine    = [5, 10, 15, 20, 50, 100]
      .map(n => { const v = calcAvg(state.history, n); return v !== null ? `Avg${n} $${v.toFixed(2)}` : null; })
      .filter(Boolean).join(' | ');
    const sEmoji = state.streakDir === 'down' ? '🔴' : '🟢';
    const msg = [
      `${tierInfo.emoji} Total Value: $${bestUsd.toFixed(2)} [${tierInfo.name}]`,
      `📍 Döngü: ${posInCycle}/${CYCLE_SIZE} (~${remaining} kaldı) — Döngü Avg: $${cycleAvg.toFixed(2)}`,
      `${sEmoji} Streak: ${state.streak}`,
      avgLine ? `📊 ${avgLine}` : null,
      `👤 ${from}`,
      `🕐 ${date} | <a href="${txUrl}">TX</a>`,
    ].filter(Boolean).join('\n');
    console.log(`[✓] ${tierInfo.name} $${bestUsd.toFixed(2)} cycle=${posInCycle}/${CYCLE_SIZE} streak=${state.streak} | ${txHash.slice(0,10)}`);
    await sendNotification(msg);
  } else {
    const msg = `${tierInfo.emoji} $${bestUsd.toFixed(2)} [${tierInfo.name}] 👤 ${from} 🕐 ${date} | <a href="${txUrl}">TX</a>`;
    console.log(`[spam] tier${tier} $${bestUsd.toFixed(2)} | ${txHash.slice(0,10)}`);
    await sendNotification(msg);
  }
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
        if (!isClaimInput(tx.data || tx.input || '')) continue;
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
  console.log('[HISTORY] Blockscout API...');
  try {
    const r = await axios.get(
      `https://base.blockscout.com/api/v2/addresses/${CONTRACT}/transactions`,
      { params: { filter: 'to' }, timeout: 15000 }
    );
    const items = r.data?.items || [];
    console.log(`[HISTORY] ${items.length} TX`);
    const claimTxs = items
      .filter(tx => {
        if (tx.status !== 'ok') return false;
        const method = (tx.method || '').toLowerCase();
        if (method.includes('claim') || method.includes('redeem') || method.includes('scratch')) return true;
        const raw = tx.raw_input || '';
        return CLAIM_SELECTORS.has(raw.slice(0, 10).toLowerCase()) || raw.length === 330;
      })
      .sort((a, b) => a.block - b.block);
    console.log(`[HISTORY] ${claimTxs.length} claim TX`);
    for (const tx of claimTxs) {
      try {
        const blockTs  = Math.floor(new Date(tx.timestamp).getTime() / 1000);
        const fromAddr = tx.from?.hash || tx.from;
        if (!fromAddr) continue;
        await processClaimTx(tx.hash, fromAddr, tx.raw_input || '', tx.block, blockTs);
      } catch (e) { console.error('[HISTORY tx]', e.message); }
    }
  } catch (e) { console.error('[HISTORY]', e.message); }
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
        const txs  = await scanBlocks(from, to);
        for (const tx of txs)
          if (!processedTxs.has(tx.hash))
            await processClaimTx(tx.hash, tx.from, tx.data, tx.blockNum, tx.blockTs);
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
  const state    = ts(tierNum);
  const tierInfo = getTierInfo(tierNum);
  if (!state.count) return `${tierInfo.emoji} Henüz ${tierInfo.name} kaydı yok.`;
  const posInCycle = ((state.count - 1) % CYCLE_SIZE) + 1;
  const cycleAvg   = state.history.slice(0, posInCycle).reduce((s, c) => s + c.usd, 0) / posInCycle;
  const sEmoji     = state.streakDir === 'down' ? '🔴' : '🟢';
  const avgLines   = [5, 10, 15, 20, 50, 100]
    .map(n => { const v = calcAvg(state.history, n); return v !== null ? `Avg${n}: $${v.toFixed(2)}` : null; })
    .filter(Boolean).join('\n');
  return [
    `${tierInfo.emoji} <b>${tierInfo.name.toUpperCase()} İstatistikleri</b> ${VERSION}`,
    '',
    `Toplam: ${state.sessionCount}/${tierInfo.target}`,
    `📍 Döngü: ${posInCycle}/${CYCLE_SIZE} — Avg: $${cycleAvg.toFixed(2)}`,
    `${sEmoji} Streak: ${state.streak}`,
    '',
    avgLines || 'Yetersiz veri',
  ].join('\n');
}

const TIERS_ORDER = [1, 2];

async function startConversation(chatId) {
  const lines = [`👋 <b>Scratch Card Tracker</b> ${VERSION}`, '', '📊 Döngü Sayıcıları:'];
  for (const t of TIERS_ORDER) {
    const info = getTierInfo(t);
    lines.push(`  • ${info.emoji} ${info.name}: Kaç paket açıldı? (?/${info.target})`);
  }
  lines.push('', '💬 Sırayla cevapla');
  await bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML' });
  conversations[chatId] = { step: 0, data: {} };
  const first = getTierInfo(TIERS_ORDER[0]);
  await bot.sendMessage(chatId, `${first.emoji} ${first.name} ($${first.nominalUsd}): Kaç paket açıldı? (?/${first.target})`);
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
    const next = getTierInfo(TIERS_ORDER[conv.step]);
    await bot.sendMessage(chatId, `${next.emoji} ${next.name} ($${next.nominalUsd}): Kaç paket açıldı? (?/${next.target})`);
  } else {
    delete conversations[chatId];
    for (const t of TIERS_ORDER)
      if (conv.data[t] !== undefined) ts(t).sessionCount = conv.data[t];
    const lines = ['✅ Döngü Sayıcıları Ayarlandı:'];
    for (const t of TIERS_ORDER) {
      const info = getTierInfo(t);
      const avg  = overallAvg(t);
      lines.push(`  • ${info.emoji} ${info.name}: ${ts(t).sessionCount}/${info.target} (ort: ${avg !== null ? '$'+avg.toFixed(2) : 'N/A'})`);
    }
    lines.push('', '💡 Yeni paket gelince sayıç otomatik ilerleyecek.');
    await bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML' });
  }
}

async function validateChannel() {
  if (!CHANNEL_ID) return;
  try {
    const me = await bot.getMe();
    const meId = String(me.id);
    const chanStr = String(CHANNEL_ID);
    if (chanStr === meId || chanStr === '@' + me.username) {
      console.error(`[HATA] TELEGRAM_CHANNEL_ID bota ait ID! Bir kanal veya grup ID'si girin (orn: -1001234567890)`);
      process.exit(1);
    }
    console.log(`[CHANNEL] ${CHANNEL_ID} kullanılıyor`);
  } catch (e) { console.warn('[CHANNEL validate]', e.message); }
}

async function main() {
  provider = await getProvider();
  bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

  await validateChannel();

  bot.onText(/\/start/, (msg) => startConversation(msg.chat.id).catch(console.error));
  bot.onText(/\/sc1/,   (msg) => bot.sendMessage(msg.chat.id, buildTierMsg(1), { parse_mode: 'HTML' }).catch(console.error));
  bot.onText(/\/sc5/,   (msg) => bot.sendMessage(msg.chat.id, buildTierMsg(2), { parse_mode: 'HTML' }).catch(console.error));

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
        console.error('[TG] 409 Conflict — başka bir instance aktif!');
      if (pollingErrCount > 80) { process.exit(1); }
    } else {
      pollingErrCount = 0;
      console.error('[TG polling]', e.message);
    }
  });

  console.log(`[${VERSION}] Contract: ${CONTRACT}`);
  await loadHistory();
  console.log(`[HISTORY] opal=${ts(1).count}  jade=${ts(2).count}`);
  lastPollBlock = 0;
  await pollLoop();
}

main().catch(e => { console.error('[FATAL]', e); process.exit(1); });
