/**
 * پامپ‌یاب حرفه‌ای — نسخه‌ی کامل
 * رصد رشد/افت کوتاه‌مدت قیمت رمزارزها (از CoinGecko)، فیلتر نقدینگی،
 * چند بازه‌ی زمانی هم‌زمان، امتیاز اطمینان (+ تأیید روند ۴ ساعته)،
 * لیست سیاه/سفید، تاریخچه، بک‌تست ساده، دکمه‌های شیشه‌ای تلگرام،
 * ذخیره‌ی تنظیمات، و کنترل زنده از تلگرام.
 */

const fs = require("fs");
const path = require("path");

// ---------------- تنظیمات پایه ----------------
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const HYSTERESIS_PERCENT = parseFloat(process.env.HYSTERESIS_PERCENT || "1.5");
const POLL_SECONDS       = parseFloat(process.env.POLL_SECONDS || "15");
const PAGES              = parseInt(process.env.PAGES || "1", 10);
const COINGECKO_API_KEY  = process.env.COINGECKO_API_KEY || "";
const MIN_VOLUME_USD     = parseFloat(process.env.MIN_VOLUME_USD || "5000000");
const WINDOWS_MINUTES = (process.env.WINDOWS_MINUTES || "1,5,15")
  .split(",").map((s) => parseFloat(s.trim())).filter((n) => !isNaN(n) && n > 0);
const MAX_WINDOW_MINUTES = Math.max.apply(null, WINDOWS_MINUTES);
const DEFAULT_BLACKLIST = ["tether","usd-coin","dai","binance-usd","first-digital-usd",
  "true-usd","frax","paypal-usd","usdd","gemini-dollar","usdt-erc20"];
const ENV_BLACKLIST = (process.env.BLACKLIST_IDS || "").split(",").map((s)=>s.trim()).filter(Boolean);

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error("خطا: TELEGRAM_BOT_TOKEN و TELEGRAM_CHAT_ID رو تنظیم کن (راهنما در README.md).");
  process.exit(1);
}

// ---------------- حالت قابل‌تغییر + ذخیره‌سازی ----------------
const STATE_FILE = path.join(__dirname, "state.json");
let state = {
  threshold: parseFloat(process.env.THRESHOLD_PERCENT || "5"),
  dumpThreshold: -Math.abs(parseFloat(process.env.DUMP_THRESHOLD_PERCENT || "5")),
  paused: false,
  watchlist: [],
  blacklist: DEFAULT_BLACKLIST.concat(ENV_BLACKLIST),
  history: [], // [{t, type, symbol, name, detail, id, price}]
};
function loadState() {
  try {
    state = Object.assign(state, JSON.parse(fs.readFileSync(STATE_FILE, "utf8")));
    console.log("تنظیمات قبلی از فایل بارگذاری شد.");
  } catch (e) { console.log("فایل تنظیمات قبلی پیدا نشد؛ از مقادیر پیش‌فرض استفاده می‌شه."); }
}
function saveState() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }
  catch (e) { console.error("خطا در ذخیره‌ی تنظیمات:", e.message); }
}
loadState();

const history = new Map();
const meta = new Map();
const notifiedPump = new Map();
const notifiedDump = new Map();

let lastPollAt = null;
let consecutiveErrors = 0;
let downAlertSent = false;

// ---------------- ابزارهای کمکی ----------------
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function fmtNum(n) {
  if (n == null || isNaN(n)) return "—";
  if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return n.toString();
}
function chartLink(id) { return `https://www.coingecko.com/en/coins/${id}`; }

function sendTelegram(text, keyboard) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const body = { chat_id: TELEGRAM_CHAT_ID, text: text };
  if (keyboard) body.reply_markup = { inline_keyboard: keyboard };
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch((err) => console.error("خطا در ارسال پیام تلگرام:", err.message));
}
function answerCallback(id, text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`;
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: id, text: text, show_alert: false }),
  }).catch(() => {});
}

// ---------------- تأیید روند ۴ ساعته ----------------
async function fetchOHLC4h(id) {
  const url = `https://api.coingecko.com/api/v3/coins/${id}/ohlc?vs_currency=usd&days=7`;
  const headers = {};
  if (COINGECKO_API_KEY) headers["x-cg-demo-api-key"] = COINGECKO_API_KEY;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error("ohlc_failed_" + res.status);
  return res.json(); // [[time, open, high, low, close], ...] هر کندل تقریباً ۴ ساعته‌ست
}
async function trendConfirmation(id, direction) {
  try {
    const candles = await fetchOHLC4h(id);
    if (!candles || candles.length < 2) return { known: false };
    const last2 = candles.slice(-2);
    const bullish = last2.every((c) => c[4] > c[1]);
    const bearish = last2.every((c) => c[4] < c[1]);
    if (direction === "up") return { known: true, aligned: bullish, opposite: bearish };
    return { known: true, aligned: bearish, opposite: bullish };
  } catch (e) {
    return { known: false };
  }
}

// ---------------- امتیاز اطمینان ----------------
function confidenceScore(m, changeAbs, trend) {
  let score = 0;
  if (m.volume >= MIN_VOLUME_USD * 5) score += 25;
  else if (m.volume >= MIN_VOLUME_USD * 2) score += 12;

  if (m.rank && m.rank <= 100) score += 25;
  else if (m.rank && m.rank <= 300) score += 12;
  else if (m.rank && m.rank <= 500) score += 5;

  if (m.marketCap && m.marketCap > 0) {
    const turnover = m.volume / m.marketCap;
    if (turnover > 0.15) score += 15;
    else if (turnover > 0.07) score += 8;
  }

  if (changeAbs >= 5 && changeAbs <= 25) score += 15;
  else if (changeAbs > 25) score += 6;

  let trendLine = "روند ۴ ساعته: نامشخص";
  if (trend && trend.known) {
    if (trend.aligned) { score += 20; trendLine = "روند ۴ ساعته: هم‌جهت ✅"; }
    else if (trend.opposite) { score -= 10; trendLine = "روند ۴ ساعته: مخالف ⚠️"; }
    else trendLine = "روند ۴ ساعته: مبهم";
  }

  score = Math.max(0, Math.min(100, score));
  const label = score >= 70 ? "قوی 🟢" : score >= 40 ? "متوسط 🟡" : "ضعیف 🔴";
  return { score, label, trendLine };
}

// ---------------- دریافت داده‌ی بازار ----------------
async function fetchMarketsPage(page) {
  const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=${page}&sparkline=false`;
  const headers = {};
  if (COINGECKO_API_KEY) headers["x-cg-demo-api-key"] = COINGECKO_API_KEY;
  const res = await fetch(url, { headers });
  if (res.status === 429) throw new Error("rate_limited_429");
  if (!res.ok) throw new Error("coingecko_failed_" + res.status);
  return res.json();
}
async function fetchMarketsByIds(ids) {
  if (!ids.length) return [];
  const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${ids.join(",")}&sparkline=false`;
  const headers = {};
  if (COINGECKO_API_KEY) headers["x-cg-demo-api-key"] = COINGECKO_API_KEY;
  const res = await fetch(url, { headers });
  if (res.status === 429) throw new Error("rate_limited_429");
  if (!res.ok) throw new Error("coingecko_failed_" + res.status);
  return res.json();
}
async function searchCoinBySymbol(symbol) {
  const url = `https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(symbol)}`;
  const headers = {};
  if (COINGECKO_API_KEY) headers["x-cg-demo-api-key"] = COINGECKO_API_KEY;
  const res = await fetch(url, { headers });
  if (!res.ok) return null;
  const data = await res.json();
  if (!data.coins || !data.coins.length) return null;
  const exact = data.coins.filter((c) => c.symbol.toLowerCase() === symbol.toLowerCase());
  const pool = exact.length ? exact : data.coins;
  pool.sort((a, b) => (a.market_cap_rank || 999999) - (b.market_cap_rank || 999999));
  return pool[0];
}

function pushPrice(id, price, now) {
  const windowMs = MAX_WINDOW_MINUTES * 60 * 1000;
  const bufferMs = windowMs + POLL_SECONDS * 1000 * 2;
  let arr = history.get(id);
  if (!arr) { arr = []; history.set(id, arr); }
  arr.push({ t: now, p: price });
  while (arr.length && now - arr[0].t > bufferMs) arr.shift();
}
function computeChanges(arr, now) {
  const changes = {};
  for (const w of WINDOWS_MINUTES) {
    const windowMs = w * 60 * 1000;
    let base = arr[0];
    for (let i = 0; i < arr.length; i++) {
      if (now - arr[i].t <= windowMs) { base = arr[i]; break; }
      base = arr[i];
    }
    changes[w] = (base && base.p > 0) ? ((arr[arr.length - 1].p - base.p) / base.p) * 100 : null;
  }
  return changes;
}
function pushHistoryLog(type, symbol, name, detail, id, price) {
  state.history.unshift({ t: Date.now(), type, symbol, name, detail, id, price });
  if (state.history.length > 60) state.history.length = 60;
  saveState();
}

// ---------------- ارزیابی و اطلاع‌رسانی ----------------
async function evaluate(now) {
  const watchIds = new Set(state.watchlist.map((w) => w.id));
  for (const [id, arr] of history.entries()) {
    if (arr.length < 2) continue;
    const m = meta.get(id);
    if (!m) continue;
    if (state.blacklist.includes(id)) continue;
    const isWatched = watchIds.has(id);
    if (!isWatched && m.volume < MIN_VOLUME_USD) continue;

    const changes = computeChanges(arr, now);
    const vals = Object.values(changes).filter((v) => v != null);
    if (!vals.length) continue;
    const maxChange = Math.max.apply(null, vals);
    const minChange = Math.min.apply(null, vals);
    const latestPrice = arr[arr.length - 1].p;

    const pumpWindows = WINDOWS_MINUTES.filter((w) => changes[w] != null && changes[w] >= state.threshold);
    const wasPump = notifiedPump.get(id) || false;
    if (pumpWindows.length) {
      if (!wasPump) {
        notifiedPump.set(id, true);
        const trend = await trendConfirmation(id, "up");
        const conf = confidenceScore(m, maxChange, trend);
        const lines = pumpWindows.map((w) => `${w} دقیقه: +${changes[w].toFixed(1)}٪`).join("\n");
        const label = `${m.symbol.toUpperCase()} +${maxChange.toFixed(1)}٪`;
        sendTelegram(
          `🚀 پامپ شناسایی شد: ${m.symbol.toUpperCase()} (${m.name})${isWatched ? " ⭐" : ""}\n${lines}\n` +
          `قیمت فعلی: $${latestPrice}\n` +
          `حجم ۲۴ ساعته: $${fmtNum(m.volume)} | رتبه: #${m.rank || "—"}\n` +
          `${conf.trendLine}\n` +
          `اطمینان: ${conf.label} (${conf.score}/100)`,
          [[{ text: "📈 نمودار", url: chartLink(id) }, { text: "🚫 مسدود کن", callback_data: "blacklist:" + id }]]
        );
        pushHistoryLog("پامپ", m.symbol.toUpperCase(), m.name, label, id, latestPrice);
        console.log(`[PUMP] ${label}`);
      }
    } else if (maxChange < state.threshold - HYSTERESIS_PERCENT) {
      notifiedPump.set(id, false);
    }

    const dumpWindows = WINDOWS_MINUTES.filter((w) => changes[w] != null && changes[w] <= state.dumpThreshold);
    const wasDump = notifiedDump.get(id) || false;
    if (dumpWindows.length) {
      if (!wasDump) {
        notifiedDump.set(id, true);
        const trend = await trendConfirmation(id, "down");
        const conf = confidenceScore(m, Math.abs(minChange), trend);
        const lines = dumpWindows.map((w) => `${w} دقیقه: ${changes[w].toFixed(1)}٪`).join("\n");
        const label = `${m.symbol.toUpperCase()} ${minChange.toFixed(1)}٪`;
        sendTelegram(
          `🔻 افت شدید: ${m.symbol.toUpperCase()} (${m.name})${isWatched ? " ⭐" : ""}\n${lines}\n` +
          `قیمت فعلی: $${latestPrice}\n` +
          `حجم ۲۴ ساعته: $${fmtNum(m.volume)} | رتبه: #${m.rank || "—"}\n` +
          `${conf.trendLine}\n` +
          `اطمینان: ${conf.label} (${conf.score}/100)`,
          [[{ text: "📈 نمودار", url: chartLink(id) }, { text: "🚫 مسدود کن", callback_data: "blacklist:" + id }]]
        );
        pushHistoryLog("دامپ", m.symbol.toUpperCase(), m.name, label, id, latestPrice);
        console.log(`[DUMP] ${label}`);
      }
    } else if (minChange > state.dumpThreshold + HYSTERESIS_PERCENT) {
      notifiedDump.set(id, false);
    }
  }
}

// ---------------- حلقه‌ی اصلی رصد بازار ----------------
async function pollOnce() {
  if (state.paused) return;
  const now = Date.now();
  try {
    for (let p = 1; p <= PAGES; p++) {
      const coins = await fetchMarketsPage(p);
      for (const c of coins) {
        if (!c.current_price) continue;
        meta.set(c.id, { name: c.name, symbol: c.symbol, volume: c.total_volume || 0, rank: c.market_cap_rank, marketCap: c.market_cap || 0 });
        pushPrice(c.id, c.current_price, now);
      }
      if (p < PAGES) await sleep(2000);
    }
    const missing = state.watchlist.map((w) => w.id).filter((id) => !meta.has(id));
    if (missing.length) {
      await sleep(1200);
      const extra = await fetchMarketsByIds(missing);
      for (const c of extra) {
        meta.set(c.id, { name: c.name, symbol: c.symbol, volume: c.total_volume || 0, rank: c.market_cap_rank, marketCap: c.market_cap || 0 });
        pushPrice(c.id, c.current_price, now);
      }
    }
    await evaluate(now);
    lastPollAt = now;
    if (downAlertSent) sendTelegram("✅ اتصال به بازار دوباره برقرار شد.");
    consecutiveErrors = 0;
    downAlertSent = false;
  } catch (err) {
    consecutiveErrors++;
    if (err.message === "rate_limited_429") console.error(`محدودیت نرخ CoinGecko (429) — تلاش ${consecutiveErrors}.`);
    else console.error("خطا در دریافت اطلاعات بازار:", err.message);
    if (consecutiveErrors >= 5 && !downAlertSent) {
      downAlertSent = true;
      sendTelegram("⚠️ چند بار پیاپی نتونستم اطلاعات بازار رو بگیرم؛ احتمال مشکل در اتصال یا محدودیت API هست.");
    }
  }
}

// ---------------- بک‌تست ساده (بر اساس هشدارهای واقعی گذشته) ----------------
async function backtestReport(days) {
  const cutoff = Date.now() - days * 86400000;
  const relevant = state.history.filter((h) => h.t >= cutoff && h.id && h.price);
  if (!relevant.length) return "هشدار کافی برای بک‌تست توی این بازه ثبت نشده. (این بک‌تست فقط روی هشدارهای واقعی خودت کار می‌کنه، نه شبیه‌سازی کامل بازار)";
  const ids = Array.from(new Set(relevant.map((h) => h.id)));
  let currentPrices = {};
  try {
    const data = await fetchMarketsByIds(ids);
    for (const c of data) currentPrices[c.id] = c.current_price;
  } catch (e) {
    return "خطا در دریافت قیمت فعلی برای بک‌تست. دوباره امتحان کن.";
  }

  let pumpTotal = 0, pumpContinued = 0;
  let dumpTotal = 0, dumpContinued = 0;
  for (const h of relevant) {
    const now = currentPrices[h.id];
    if (now == null) continue;
    const outcomePct = ((now - h.price) / h.price) * 100;
    if (h.type === "پامپ") { pumpTotal++; if (outcomePct > 0) pumpContinued++; }
    else if (h.type === "دامپ") { dumpTotal++; if (outcomePct < 0) dumpContinued++; }
  }
  const pumpRate = pumpTotal ? ((pumpContinued / pumpTotal) * 100).toFixed(0) : "—";
  const dumpRate = dumpTotal ? ((dumpContinued / dumpTotal) * 100).toFixed(0) : "—";
  return (
    `📈 بک‌تست ${days} روز اخیر (بر اساس هشدارهای واقعی ثبت‌شده)\n\n` +
    `پامپ‌ها: ${pumpTotal} مورد — ${pumpRate}٪ تا الان همچنان بالاتر از قیمت هشدار موندن\n` +
    `دامپ‌ها: ${dumpTotal} مورد — ${dumpRate}٪ تا الان همچنان پایین‌تر از قیمت هشدار موندن\n\n` +
    `توجه: این یه شبیه‌سازی کامل بازار نیست، فقط عملکرد واقعی هشدارهایی که خودت گرفتی رو نشون می‌ده.`
  );
}

// ---------------- دستورات و دکمه‌های تلگرام ----------------
let telegramOffset = 0;

function helpText() {
  return "دستورات قابل استفاده:\n" +
    "/status — وضعیت فعلی\n" +
    "/threshold <عدد> — تغییر آستانه‌ی پامپ (٪)\n" +
    "/dumpthreshold <عدد> — تغییر آستانه‌ی افت (٪)\n" +
    "/pause — توقف موقت رصد\n" +
    "/resume — از سرگیری رصد\n" +
    "/watch <SYMBOL> — اضافه‌کردن به واچ‌لیست\n" +
    "/unwatch <SYMBOL> — حذف از واچ‌لیست\n" +
    "/watchlist — نمایش واچ‌لیست\n" +
    "/blacklist <SYMBOL> — نادیده‌گرفتن یه کوین\n" +
    "/unblacklist <SYMBOL> — حذف از لیست سیاه\n" +
    "/blacklistshow — نمایش لیست سیاه\n" +
    "/history — آخرین هشدارها\n" +
    "/backtest <روز> — عملکرد واقعی هشدارهای گذشته (پیش‌فرض ۷ روز)\n" +
    "/help — همین راهنما";
}
function statusText() {
  return "📊 وضعیت پامپ‌یاب\n" +
    `حالت: ${state.paused ? "متوقف ⏸" : "فعال ▶️"}\n` +
    `آستانه‌ی پامپ: ${state.threshold}٪ | آستانه‌ی افت: ${state.dumpThreshold}٪\n` +
    `بازه‌ها: ${WINDOWS_MINUTES.join("، ")} دقیقه | حداقل حجم: $${fmtNum(MIN_VOLUME_USD)}\n` +
    `کوین‌های تحت رصد: ${history.size} | واچ‌لیست: ${state.watchlist.length} | لیست سیاه: ${state.blacklist.length}\n` +
    `آخرین بروزرسانی: ${lastPollAt ? new Date(lastPollAt).toLocaleTimeString("fa-IR") : "—"}`;
}
function historyText() {
  if (!state.history.length) return "هنوز هشداری ثبت نشده.";
  return "🕘 آخرین هشدارها:\n" + state.history.slice(0, 10).map((h) => {
    const time = new Date(h.t).toLocaleString("fa-IR");
    const icon = h.type === "پامپ" ? "🚀" : "🔻";
    return `${icon} ${h.detail} — ${time}`;
  }).join("\n");
}
async function resolveSymbolToId(symbolRaw) {
  const symbol = symbolRaw.toUpperCase();
  for (const [id, m] of meta.entries()) {
    if (m.symbol.toUpperCase() === symbol) return { id, symbol: m.symbol, name: m.name };
  }
  const found = await searchCoinBySymbol(symbolRaw);
  if (found) return { id: found.id, symbol: found.symbol, name: found.name };
  return null;
}

async function handleCommand(text) {
  const parts = text.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();

  if (cmd === "/status") { sendTelegram(statusText()); return; }
  if (cmd === "/help" || cmd === "/start") { sendTelegram(helpText()); return; }
  if (cmd === "/history") { sendTelegram(historyText()); return; }
  if (cmd === "/backtest") {
    const days = parseFloat(parts[1]) || 7;
    sendTelegram("در حال محاسبه‌ی بک‌تست...");
    const report = await backtestReport(days);
    sendTelegram(report);
    return;
  }
  if (cmd === "/threshold") {
    const v = parseFloat(parts[1]);
    if (!isNaN(v) && v > 0) { state.threshold = v; saveState(); sendTelegram(`✅ آستانه‌ی پامپ روی ${v}٪ تنظیم شد.`); }
    else sendTelegram("عدد نامعتبر. مثال: /threshold 7");
    return;
  }
  if (cmd === "/dumpthreshold") {
    const v = parseFloat(parts[1]);
    if (!isNaN(v) && v > 0) { state.dumpThreshold = -v; saveState(); sendTelegram(`✅ آستانه‌ی افت روی ${-v}٪ تنظیم شد.`); }
    else sendTelegram("عدد نامعتبر. مثال: /dumpthreshold 6");
    return;
  }
  if (cmd === "/pause") { state.paused = true; saveState(); sendTelegram("⏸ رصد بازار متوقف شد."); return; }
  if (cmd === "/resume") { state.paused = false; saveState(); sendTelegram("▶️ رصد بازار از سر گرفته شد."); return; }

  if (cmd === "/watch") {
    if (!parts[1]) { sendTelegram("مثال: /watch BTC"); return; }
    const found = await resolveSymbolToId(parts[1]);
    if (!found) { sendTelegram("کوینی با این نماد پیدا نشد."); return; }
    if (!state.watchlist.some((w) => w.id === found.id)) {
      state.watchlist.push(found); saveState();
      sendTelegram(`⭐ ${found.symbol.toUpperCase()} به واچ‌لیست اضافه شد.`);
    } else sendTelegram("این کوین از قبل توی واچ‌لیسته.");
    return;
  }
  if (cmd === "/unwatch") {
    if (!parts[1]) { sendTelegram("مثال: /unwatch BTC"); return; }
    const symbol = parts[1].toUpperCase();
    const before = state.watchlist.length;
    state.watchlist = state.watchlist.filter((w) => w.symbol.toUpperCase() !== symbol);
    saveState();
    sendTelegram(state.watchlist.length < before ? `${symbol} از واچ‌لیست حذف شد.` : "این کوین توی واچ‌لیست نبود.");
    return;
  }
  if (cmd === "/watchlist") {
    sendTelegram(state.watchlist.length ? "⭐ واچ‌لیست:\n" + state.watchlist.map((w) => w.symbol.toUpperCase()).join("، ") : "واچ‌لیست خالیه.");
    return;
  }
  if (cmd === "/blacklist") {
    if (!parts[1]) { sendTelegram("مثال: /blacklist DOGE"); return; }
    const found = await resolveSymbolToId(parts[1]);
    if (!found) { sendTelegram("کوینی با این نماد پیدا نشد."); return; }
    if (!state.blacklist.includes(found.id)) { state.blacklist.push(found.id); saveState(); sendTelegram(`🚫 ${found.symbol.toUpperCase()} به لیست سیاه اضافه شد.`); }
    else sendTelegram("این کوین از قبل توی لیست سیاهه.");
    return;
  }
  if (cmd === "/unblacklist") {
    if (!parts[1]) { sendTelegram("مثال: /unblacklist DOGE"); return; }
    const found = await resolveSymbolToId(parts[1]);
    if (!found) { sendTelegram("کوینی با این نماد پیدا نشد."); return; }
    const before = state.blacklist.length;
    state.blacklist = state.blacklist.filter((id) => id !== found.id);
    saveState();
    sendTelegram(state.blacklist.length < before ? `${found.symbol.toUpperCase()} از لیست سیاه حذف شد.` : "این کوین توی لیست سیاه نبود.");
    return;
  }
  if (cmd === "/blacklistshow") { sendTelegram("🚫 لیست سیاه:\n" + state.blacklist.join("، ")); return; }
}

async function handleCallback(cq) {
  const data = cq.data || "";
  if (data.startsWith("blacklist:")) {
    const id = data.slice("blacklist:".length);
    if (!state.blacklist.includes(id)) { state.blacklist.push(id); saveState(); }
    const m = meta.get(id);
    answerCallback(cq.id, (m ? m.symbol.toUpperCase() : id) + " مسدود شد ✅");
  } else {
    answerCallback(cq.id, "دستور ناشناخته");
  }
}

async function pollTelegramCommands() {
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${telegramOffset}&timeout=0`;
    const res = await fetch(url);
    const data = await res.json();
    if (!data.ok || !Array.isArray(data.result)) return;
    for (const upd of data.result) {
      telegramOffset = upd.update_id + 1;
      if (upd.callback_query) {
        const cq = upd.callback_query;
        if (String(cq.message.chat.id) !== String(TELEGRAM_CHAT_ID)) continue;
        await handleCallback(cq);
        continue;
      }
      const msg = upd.message;
      if (!msg || !msg.text) continue;
      if (String(msg.chat.id) !== String(TELEGRAM_CHAT_ID)) continue;
      await handleCommand(msg.text);
    }
  } catch (err) {
    console.error("خطا در دریافت دستورات تلگرام:", err.message);
  }
}

// ---------------- شروع ----------------
let started = false;
function start() {
  if (started) return;
  started = true;
  console.log("شروع رصد بازار از CoinGecko..." + (COINGECKO_API_KEY ? " (با کلید API)" : " (بدون کلید API)"));
  sendTelegram(
    `✅ پامپ‌یاب فعال شد.\nآستانه‌ی پامپ: ${state.threshold}٪ | آستانه‌ی افت: ${state.dumpThreshold}٪\n` +
    `بازه‌ها: ${WINDOWS_MINUTES.join("، ")} دقیقه | حداقل حجم: $${fmtNum(MIN_VOLUME_USD)}\n` +
    `برای دیدن دستورات: /help`
  );
  pollOnce();
  setInterval(pollOnce, POLL_SECONDS * 1000);
  setInterval(pollTelegramCommands, 4000);
}
start();

const http = require("http");
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(
    "پامپ‌یاب در حال اجراست.\n" +
    "حالت: " + (state.paused ? "متوقف" : "فعال") + "\n" +
    "کوین‌های تحت رصد: " + history.size + "\n" +
    "آخرین بروزرسانی: " + (lastPollAt ? new Date(lastPollAt).toISOString() : "—")
  );
}).listen(PORT, () => console.log("سرور وضعیت روی پورت " + PORT + " بالا اومد."));
