require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { ethers } = require('ethers');
const axios = require('axios');

const VERSION = 'v7.1';
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;
const CONTRACT = process.env.TOKEN_CONTRACT || '0xAe5F595803B2AA4D07aF8b392e535876a974a296';

if (!TELEGRAM_TOKEN) { console.error('TELEGRAM_BOT_TOKEN eksik!'); process.exit(1); }
if (!CHANNEL_ID) console.warn('[WARN] TELEGRAM_CHANNEL_ID ayarlı değil — otomatik bildirim kapalı');

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

// Known claim() function selectors
const CLAIM_SELECTORS = new Set([
  '0x4e71d92d', // claim()
  '0x379607f5', // claim(uint256)
  '0x1e83409a', // claim(address)
  '0x48c54b9d', // claimTokens()
  '0x2e7ba6ef', // redeem(uint256)
  '0xbd66528a', // scratch()
  '0xdb006a75', // redeem()
  '0x96c55175', // claim(uint256,address)
  '0x7d49ec34', // claim(uint256,bytes32[])
  '0xae169a50', // claimReward(uint256)
]);

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const CHAINLINK_ETHUSD = '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70';
const WETH  = '0x4200000000000000000000000000000000000006';
const USDC  = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const UNI_FACTORY  = '0x33128a8fC17869897dcE68Ed026d694621f6FDfD';
const AERO_FACTORY = '0x420DD381b31aEf6683db6B902084cB0FFECe40Da';

// ─── State ───────────────────────────────────────────────────────────────────
let claimHistory = [];
const CYCLE_SIZE = 50;
let claimCount = 0;
let streak = 0;
let streakDir = null;
let processedTxs = new Set();
let pollingErrCount = 0;

let provider, bot;
let tokenInfoCache = {};
let priceCache = {};
let ethPrice = 0, ethPriceAt = 0;
let lastPollBlock = 0;

// ─── Provider ────────────────────────────────────────────────────────────────
async function getProvider() {
  for (const rpc of RPCS) {
    try {
      const p = new ethers.JsonRpcProvider(rpc);
      await Promise.race([
        p.getBlockNumber(),
        new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 5000)),
      ]);
      console.log(`[RPC ✓] ${rpc}`);
      return p;
    } catch (e) {
      console.log(`[RPC ✗] ${e.message.slice(0, 80)}`);
    }
  }
  throw new Error('Hiçbir RPC bağlanamadı');
}

async function getEthUsd() {
  if (Date.now() - ethPriceAt < 60_000 && ethPrice > 0) return ethPrice;
  try {
    const cl = new ethers.Contract(
      CHAINLINK_ETHUSD,
      ['function latestAnswer() view returns (int256)'],
      provider
    );
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
    const r = await axios.get(
      `https://base.blockscout.com/api/v2/tokens/${address}`,
      { timeout: 6000 }
    );
    if (r.data?.symbol) {
      symbol = r.data.symbol;
      decimals = parseInt(r.data.decimals ?? 18);
      tokenInfoCache[k] = { symbol, decimals };
      return tokenInfoCache[k];
    }
  } catch (_) {}
  const c = new ethers.Contract(
    address,
    ['function symbol() view returns (string)', 'function decimals() view returns (uint8)'],
    provider
  );
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

  // Uniswap V3
  const uniFactory = new ethers.Contract(
    UNI_FACTORY,
    ['function getPool(address,address,uint24) view returns (address)'],
    provider
  );
  for (const [quote, qDec, isEth] of [[WETH, 18, true], [USDC, 6, false]]) {
    for (const fee of [100, 500, 3000, 10000]) {
      try {
        const poolAddr = await uniFactory.getPool(address, quote, fee);
        if (!poolAddr || poolAddr === ethers.ZeroAddress) continue;
        const pool = new ethers.Contract(poolAddr, [
          'function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)',
          'function token0() view returns (address)',
        ], provider);
        const [s, t0] = await Promise.all([pool.slot0(), pool.token0()]);
        const isT0 = t0.toLowerCase() === k;
        const sq = Number(s[0]) / 2 ** 96;
        const pr = sq * sq;
        const priceInQuote = isT0
          ? pr * (10 ** qDec) / (10 ** decimals)
          : (1 / pr) * (10 ** decimals) / (10 ** qDec);
        const priceUsd = isEth ? priceInQuote * await getEthUsd() : priceInQuote;
        if (priceUsd > 0 && priceUsd < 1e12) {
          priceCache[k] = { price: priceUsd, at: Date.now() };
          console.log(`[PRICE] UniV3 $${priceUsd.toExponential(4)}`);
          return priceUsd;
        }
      } catch (_) {}
    }
  }

  // Aerodrome V2
  try {
    const aeroFactory = new ethers.Contract(
      AERO_FACTORY,
      ['function getPair(address,address,bool) view returns (address)'],
      provider
    );
    for (const [quote, qDec, isEth] of [[WETH, 18, true], [USDC, 6, false]]) {
      for (const stable of [false, true]) {
        try {
          const pairAddr = await aeroFactory.getPair(address, quote, stable);
          if (!pairAddr || pairAddr === ethers.ZeroAddress) continue;
          const pair = new ethers.Contract(pairAddr, [
            'function getReserves() view returns (uint112,uint112,uint32)',
            'function token0() view returns (address)',
          ], provider);
          const [res, t0] = await Promise.all([pair.getReserves(), pair.token0()]);
          const isT0 = t0.toLowerCase() === k;
          const tokR = Number(ethers.formatUnits(isT0 ? res[0] : res[1], decimals));
          const quoR = Number(ethers.formatUnits(isT0 ? res[1] : res[0], qDec));
          if (tokR <= 0 || quoR <= 0) continue;
          const priceUsd = isEth
            ? (quoR / tokR) * await getEthUsd()
            : quoR / tokR;
          if (priceUsd > 0 && priceUsd < 1e12) {
            priceCache[k] = { price: priceUsd, at: Date.now() };
            console.log(`[PRICE] Aerodrome $${priceUsd.toExponential(4)}`);
            return priceUsd;
          }
        } catch (_) {}
      }
    }
  } catch (_) {}

  // DexScreener fallback
  try {
    const r = await axios.get(
      `https://api.dexscreener.com/latest/dex/tokens/${address}`,
      { timeout: 8000 }
    );
    const pairs = (r.data?.pairs || []).filter(p => p.chainId === 'base');
    if (pairs.length) {
      const price = parseFloat(pairs[0].priceUsd);
      if (price > 0) {
        priceCache[k] = { price, at: Date.now() };
        console.log(`[PRICE] DexScreener $${price.toExponential(4)}`);
        return price;
      }
    }
  } catch (_) {}

  console.warn(`[PRICE] ${address.slice(0, 10)}... için fiyat bulunamadı`);
  return null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function calcAvg(arr, n) {
  if (arr.length < n) return null;
  return arr.slice(0, n).reduce((s, v) => s + v.usd, 0) / n;
}

function isClaimInput(data) {
  if (!data || data.length < 10) return false;
  return CLAIM_SELECTORS.has(data.slice(0, 10).toLowerCase());
}

// ─── Process one claim TX ───────────────────────────────────────────────────
async function processClaimTx(txHash, from, data, blockNum, blockTs) {
  if (processedTxs.has(txHash)) return;
  processedTxs.add(txHash);
  if (processedTxs.size > 20000) {
    const arr = [...processedTxs];
    processedTxs = new Set(arr.slice(-10000));
  }

  let receipt;
  try {
    receipt = await provider.getTransactionReceipt(txHash);
  } catch (_) { return; }
  if (!receipt || receipt.status === 0) return;

  const claimer = from.toLowerCase();

  // ERC20 transfers TO claimer
  const received = {};
  for (const log of receipt.logs) {
    if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
    if (log.topics.length < 3) continue;
    const to = ('0x' + log.topics[2].slice(26)).toLowerCase();
    if (to !== claimer) continue;
    const tokenAddr = log.address.toLowerCase();
    const amount = BigInt(log.data);
    received[tokenAddr] = (received[tokenAddr] ?? 0n) + amount;
  }

  if (!Object.keys(received).length) {
    console.log(`[SKIP ${txHash.slice(0, 10)}] alıcıya transfer yok`);
    return;
  }

  // Pick best (highest USD) token
  let bestUsd = 0, bestToken = null;
  for (const [addr, rawAmt] of Object.entries(received)) {
    try {
      const info  = await getTokenInfo(addr);
      const human = Number(ethers.formatUnits(rawAmt, info.decimals));
      const price = await getTokenPriceUsd(addr);
      if (!price) continue;
      const usd = human * price;
      if (usd > bestUsd) { bestUsd = usd; bestToken = { addr, ...info, price }; }
    } catch (_) {}
  }

  if (!bestToken || bestUsd <= 0) {
    console.log(`[SKIP ${txHash.slice(0, 10)}] fiyat bulunamadı`);
    return;
  }

  const packetType = bestUsd >= 2.5 ? '$5' : '$1';

  if (claimHistory.length > 0) {
    const dir = bestUsd >= claimHistory[0].usd ? 'up' : 'down';
    streak    = dir === streakDir ? streak + 1 : 1;
    streakDir = dir;
  } else {
    streak = 1; streakDir = null;
  }

  claimCount++;
  claimHistory.unshift({ usd: bestUsd, ts: blockTs * 1000, hash: txHash, claimer: from });
  if (claimHistory.length > 200) claimHistory.pop();

  const posInCycle = ((claimCount - 1) % CYCLE_SIZE) + 1;
  const remaining  = CYCLE_SIZE - posInCycle;
  const cycleAvg   = claimHistory.slice(0, posInCycle).reduce((s, c) => s + c.usd, 0) / posInCycle;

  const avgLine = [5, 10, 15, 20, 50, 100]
    .map(n => { const v = calcAvg(claimHistory, n); return v !== null ? `Avg${n} $${v.toFixed(2)}` : null; })
    .filter(Boolean)
    .join(' | ');

  const sEmoji = streakDir === 'up' ? '🔺' : '🔻';
  const date   = new Date(blockTs * 1000).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
  const txUrl  = `https://basescan.org/tx/${txHash}`;

  const msg = [
    `Total Value: $${bestUsd.toFixed(2)} [${packetType}]`,
    `📍 Döngü: ${posInCycle}/${CYCLE_SIZE} (~${remaining} kaldı) — Döngü Avg: $${cycleAvg.toFixed(2)}`,
    `${sEmoji} Streak: ${streak}`,
    avgLine ? `📊 ${avgLine}` : null,
    `👤 ${from}`,
    `🕐 ${date} | <a href="${txUrl}">TX</a>`,
  ].filter(Boolean).join('\n');

  console.log(`[✓] $${bestUsd.toFixed(2)} [${packetType}] cycle=${posInCycle}/${CYCLE_SIZE} streak=${streak} | ${txHash.slice(0, 10)}`);

  if (CHANNEL_ID) {
    try {
      await bot.sendMessage(CHANNEL_ID, msg, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      });
    } catch (e) { console.error('[TG]', e.message); }
  }
}

// ─── Block scanning (primary live strategy) ─────────────────────────────────────────
async function scanBlocksForClaimTxs(fromBlock, toBlock) {
  const found = [];
  const BATCH = 8;
  for (let b = fromBlock; b <= toBlock; b += BATCH) {
    const end = Math.min(b + BATCH - 1, toBlock);
    const promises = [];
    for (let i = b; i <= end; i++) {
      promises.push(provider.getBlock(i, true).catch(() => null));
    }
    const blocks = await Promise.all(promises);
    for (const block of blocks) {
      if (!block) continue;
      const txs = block.prefetchedTransactions || [];
      for (const tx of txs) {
        if (tx.to?.toLowerCase() !== CONTRACT_LOWER) continue;
        if (!isClaimInput(tx.data || tx.input || '')) continue;
        found.push({
          hash: tx.hash,
          from: tx.from,
          data: tx.data || tx.input,
          blockNum: Number(block.number),
          blockTs: Number(block.timestamp),
        });
      }
    }
  }
  return found;
}

// ─── Blockscout API history loader ────────────────────────────────────────────────
async function loadHistoryViaBlockscout(limit = 150) {
  console.log('[HISTORY] Blockscout API ile yükleniyor...');
  try {
    const r = await axios.get(
      `https://base.blockscout.com/api/v2/addresses/${CONTRACT}/transactions`,
      { params: { filter: 'to' }, timeout: 15000 }
    );
    const items = r.data?.items || [];
    console.log(`[HISTORY] Blockscout: ${items.length} TX döndü`);

    const claimTxs = items
      .filter(tx => {
        const sel = (tx.raw_input || '').slice(0, 10).toLowerCase();
        return tx.status === 'ok' && CLAIM_SELECTORS.has(sel);
      })
      .sort((a, b) => a.block - b.block);

    console.log(`[HISTORY] ${claimTxs.length} claim TX işlenecek`);

    for (const tx of claimTxs.slice(0, limit)) {
      try {
        const blockTs = Math.floor(new Date(tx.timestamp).getTime() / 1000);
        const fromAddr = tx.from?.hash || tx.from;
        if (!fromAddr) continue;
        await processClaimTx(tx.hash, fromAddr, tx.raw_input, tx.block, blockTs);
      } catch (e) { console.error('[HISTORY tx]', e.message); }
    }
  } catch (e) {
    console.error('[HISTORY] Blockscout API hatası:', e.message);
  }
}

// ─── Live poll loop ───────────────────────────────────────────────────────────
async function pollLoop() {
  let fails = 0;
  console.log('[POLL] Canlı izleme başlıyor...');

  while (true) {
    try {
      const cur = await provider.getBlockNumber();
      if (lastPollBlock === 0) lastPollBlock = cur - 1;

      if (cur > lastPollBlock) {
        const fromB = lastPollBlock + 1;
        const toB   = Math.min(cur, lastPollBlock + 20);

        const txs = await scanBlocksForClaimTxs(fromB, toB);
        for (const tx of txs) {
          if (processedTxs.has(tx.hash)) continue;
          await processClaimTx(tx.hash, tx.from, tx.data, tx.blockNum, tx.blockTs);
        }

        lastPollBlock = toB;
      }

      fails = 0;
      await new Promise(r => setTimeout(r, 2500));
    } catch (e) {
      fails++;
      console.error('[POLL]', e.message.slice(0, 80));
      if (fails >= 5) {
        try { provider = await getProvider(); fails = 0; } catch (_) {}
      }
      await new Promise(r => setTimeout(r, Math.min(fails * 3000, 30000)));
    }
  }
}

// ─── Telegram status ─────────────────────────────────────────────────────────────────
function buildStatusMsg() {
  if (!claimHistory.length)
    return `⏳ Henüz claim kaydı yok.\nContract: ${CONTRACT}\nVersion: ${VERSION}`;

  const posInCycle = ((claimCount - 1) % CYCLE_SIZE) + 1;
  const cycleAvg   = claimHistory.slice(0, posInCycle).reduce((s, c) => s + c.usd, 0) / posInCycle;
  const sEmoji     = streakDir === 'up' ? '🔺' : '🔻';

  const avgLines = [5, 10, 15, 20, 50, 100]
    .map(n => { const v = calcAvg(claimHistory, n); return v !== null ? `Avg${n}: $${v.toFixed(2)}` : null; })
    .filter(Boolean).join('\n');

  const last = claimHistory[0];
  return [
    `📊 <b>Scratch Card Tracker</b> ${VERSION}`,
    '',
    `Son: <code>$${last.usd.toFixed(2)}</code>`,
    `📍 Döngü: ${posInCycle}/${CYCLE_SIZE} — Avg: $${cycleAvg.toFixed(2)}`,
    `${sEmoji} Streak: ${streak}`,
    '',
    avgLines,
    '',
    `🔢 Toplam claim: ${claimCount}`,
    `📦 <code>${CONTRACT}</code>`,
  ].join('\n');
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  provider = await getProvider();

  bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

  bot.onText(/\/start|\/durum/, (msg) => {
    bot.sendMessage(msg.chat.id, buildStatusMsg(), { parse_mode: 'HTML' })
      .catch(e => bot.sendMessage(msg.chat.id, `Hata: ${e.message}`));
  });

  bot.on('polling_error', (e) => {
    if (e.message?.includes('409')) {
      pollingErrCount++;
      if (pollingErrCount === 1)
        console.error('[TG] 409 Conflict — başka bir bot instance aktif! Eski versiyonu durdur.');
      if (pollingErrCount > 80) {
        console.error('[TG] 80+ ardalan 409 — process restart için çıkılıyor');
        process.exit(1);
      }
    } else {
      pollingErrCount = 0;
      console.error('[TG polling]', e.message);
    }
  });

  console.log(`[${VERSION}] Contract: ${CONTRACT}`);

  await loadHistoryViaBlockscout(200);
  console.log(`[HISTORY] ${claimHistory.length} claim hazır`);

  lastPollBlock = 0;
  await pollLoop();
}

main().catch(e => { console.error('[FATAL]', e); process.exit(1); });
