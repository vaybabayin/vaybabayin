require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { ethers } = require('ethers');
const axios = require('axios');

const VERSION = 'v9.14';
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL_ID    = process.env.TELEGRAM_CHANNEL_ID || null;
const CONTRACT      = process.env.TOKEN_CONTRACT || '0xAe5F595803B2AA4D07aF8b392e535876a974a296';
const SC1_TARGET    = parseInt(process.env.SC1_TARGET || '200');
const SC5_TARGET    = parseInt(process.env.SC5_TARGET || '100');

if (!TELEGRAM_TOKEN) { console.error('TELEGRAM_BOT_TOKEN eksik!'); process.exit(1); }

const CONTRACT_LOWER = CONTRACT.toLowerCase();
const ZERO_ADDRESS   = '0x0000000000000000000000000000000000000000';
const USDC_LOWER     = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

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

function nftIdFromCalldata(data) {
  if (!data || data.length < 74) return null;
  try { return BigInt('0x' + data.slice(10, 74)).toString(); }
  catch (_) { return null; }
}

function collectReceived(receipt, recipient) {
  const received = {};
  for (const log of receipt.logs) {
    if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
    if (log.topics.length < 3) continue;
    const to       = ('0x' + log.topics[2].slice(26)).toLowerCase();
    const fromLog  = ('0x' + log.topics[1].slice(26)).toLowerCase();
    const tokenAddr = log.address.toLowerCase();
    if (to !== recipient) continue;
    if (tokenAddr !== CONTRACT_LOWER && fromLog !== CONTRACT_LOWER && fromLog !== ZERO_ADDRESS) continue;
    if (!log.data || log.data === '0x') continue;
    received[tokenAddr] = (received[tokenAddr] ?? 0n) + BigInt(log.data);
  }
  if (Object.keys(received).length) return { received, usedFallback: false };
  for (const log of receipt.logs) {
    if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
    if (log.topics.length < 3) continue;
    const to = ('0x' + log.topics[2].slice(26)).toLowerCase();
    if (to !== recipient) continue;
    const tokenAddr = log.address.toLowerCase();
    if (tokenAddr === WETH_LOWER) continue;
    if (!log.data || log.data === '0x') continue;
    received[tokenAddr] = (received[tokenAddr] ?? 0n) + BigInt(log.data);
  }
  return { received, usedFallback: true };
}

async function calcTotalUsd(received) {
  let totalUsd = 0;
  const tokenSummary = [];
  const droppedSummary = [];
  for (const [addr, rawAmt] of Object.entries(received)) {
    try {
      const info  = await getTokenInfo(addr);
      const human = Number(ethers.formatUnits(rawAmt, info.decimals));
      const price = await getTokenPriceUsd(addr);
      if (!price) { droppedSummary.push(`${info.symbol}=NO_PRICE`); continue; }
      const usd = human * price;
      if (usd < 0.0001) continue;
      if (usd > PER_TOKEN_MAX_USD) {
        droppedSummary.push(`${info.symbol}=$${usd.toFixed(2)}(OUTLIER)`);
        continue;
      }
      totalUsd += usd;
      tokenSummary.push(`${info.symbol}=$${usd.toFixed(4)}`);
    } catch (_) {}
  }
  return { totalUsd, tokenSummary, droppedSummary };
}

async function processTx(txHash, from, data, blockNum, blockTs) {
  if (processedTxs.has(txHash)) return;
  processedTxs.add(txHash);
  if (processedTxs.size > 20000) {
    const arr = [...processedTxs]; processedTxs = new Set(arr.slice(-10000));
  }

  let receipt;
  try { receipt = await provider.getTransactionReceipt(txHash); } catch (_) { return; }
  if (!receipt || receipt.status === 0) {
    if (!isLoadingHistory)
      console.log(`[SKIP receipt] status=${receipt?.status ?? 'null'} | ${txHash.slice(0,10)}`);
    return;
  }

  const claimer = from.toLowerCase();

  const mint = findNftMint(receipt);
  if (mint) {
    const usdPaid = findUsdcPayment(receipt, mint.to);
    const tier = classifyByUsdc(usdPaid);
    if (tier) {
      nftToTier.set(mint.nftId, { tier, buyer: mint.to, buyTxHash: txHash, buyTs: blockTs });
      if (!isLoadingHistory)
        console.log(`[BUY] nft=${mint.nftId} tier=${tier} (${TIER_INFO[tier].name}) paid=$${usdPaid.toFixed(2)} buyer=${mint.to.slice(0,10)} | ${txHash.slice(0,10)}`);
    } else {
      if (!isLoadingHistory)
        console.log(`[BUY ?] nft=${mint.nftId} paid=$${usdPaid.toFixed(2)} (tier yok) | ${txHash.slice(0,10)}`);
    }
    return;
  }

  let claimedNftId = null;
  const burn = findNftBurn(receipt);
  if (burn) claimedNftId = burn.nftId;
  if (!claimedNftId) claimedNftId = nftIdFromCalldata(data);

  let tier = null;
  if (claimedNftId && nftToTier.has(claimedNftId)) {
    tier = nftToTier.get(claimedNftId).tier;
  }

  const { received, usedFallback } = collectReceived(receipt, claimer);
  if (!Object.keys(received).length) {
    if (!isLoadingHistory)
      console.log(`[SKIP no-transfer] nft=${claimedNftId} | ${txHash.slice(0,10)}`);
    return;
  }

  const { totalUsd, tokenSummary, droppedSummary } = await calcTotalUsd(received);
  if (totalUsd <= 0) {
    if (!isLoadingHistory)
      console.log(`[SKIP no-value] nft=${claimedNftId} dropped=[${droppedSummary.join(' ')}] | ${txHash.slice(0,10)}`);
    return;
  }

  if (tier === null) {
    if (totalUsd >= 0.05 && totalUsd < 2.5) tier = 1;
    else if (totalUsd >= 2.5 && totalUsd < 10) tier = 2;
    if (tier !== null && !isLoadingHistory)
      console.log(`[FALLBACK tier=${tier}] nft=${claimedNftId} — mapping yok, USD'den ($${totalUsd.toFixed(2)}) tahmin | ${txHash.slice(0,10)}`);
  }

  if (tier === null) {
    if (!isLoadingHistory)
      console.log(`[SKIP unknown-tier] nft=${claimedNftId} won=$${totalUsd.toFixed(2)} | ${txHash.slice(0,10)}`);
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
  if (!isLoadingHistory) state.sessionCount++;
  state.history.unshift({ usd: totalUsd, ts: blockTs * 1000, hash: txHash, claimer: from });
  if (state.history.length > Math.max(cycleSize, 200)) state.history.pop();

  if (isLoadingHistory) return;

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

  console.log(`[✓] ${tierInfo.name} won=$${totalUsd.toFixed(2)} nft=${claimedNftId} cyc=${posInCycle}/${cycleSize} fb=${usedFallback} | ${tokenSummary.join(' ')} | ${txHash.slice(0,10)}`);
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
      const paid = findUsdcPayment(receipt, mint.to);
      const tier = classifyByUsdc(paid);
      lines.push(`🛒 BUY TX: NFT #${mint.nftId} mint → ${mint.to.slice(0,12)} | USDC ödeme: $${paid.toFixed(2)} → tier=${tier ?? '?'}`);
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
      }
    }

    const { received, usedFallback } = collectReceived(receipt, tx.from.toLowerCase());
    lines.push(`💸 Recipient transferi: ${Object.keys(received).length} (fallback: ${usedFallback?'evet':'hayır'})`);
    if (Object.keys(received).length) {
      const { totalUsd, tokenSummary, droppedSummary } = await calcTotalUsd(received);
      for (const t of tokenSummary)   lines.push(`  ✓ ${t}`);
      for (const d of droppedSummary) lines.push(`  ✗ ${d}`);
      lines.push(`💰 Toplam: $${totalUsd.toFixed(4)}`);
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
  console.log('[HISTORY] Blockscout API... (bildirimler suspended)');
  const countBefore = { 1: ts(1).count, 2: ts(2).count };
  try {
    const r = await axios.get(
      `https://base.blockscout.com/api/v2/addresses/${CONTRACT}/transactions`,
      { params: { filter: 'to' }, timeout: 15000 }
    );
    const items = r.data?.items || [];
    console.log(`[HISTORY] ${items.length} TX alındı, işleniyor...`);
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
  } catch (e) { console.error('[HISTORY]', e.message); }
  isLoadingHistory = false;
  const g = ts(1).count - countBefore[1];
  const p = ts(2).count - countBefore[2];
  console.log(`[HISTORY] Bitti — green=${g} purple=${p} yüklendi | NFT map=${nftToTier.size} | bildirimler açık`);
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
            await processTx(tx.hash, tx.from, tx.data, tx.blockNum, tx.blockTs);
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
  await loadHistory();
  console.log(`[HISTORY] NFT map=${nftToTier.size} | green count=${ts(1).count} sessionCount=${ts(1).sessionCount}/${SC1_TARGET}  purple count=${ts(2).count} sessionCount=${ts(2).sessionCount}/${SC5_TARGET}`);
  lastPollBlock = 0;
  await pollLoop();
}

main().catch(e => { console.error('[FATAL]', e); process.exit(1); });
