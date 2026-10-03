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
const TIMEZONE = process.env.TIMEZONE || "Asia/Tehran";
const DYNAMIC_THRESHOLD_FACTOR_DEFAULT = parseFloat(process.env.DYNAMIC_THRESHOLD_FACTOR || "0.4");
const VOLUME_SPIKE_MULTIPLIER_DEFAULT = parseFloat(process.env.VOLUME_SPIKE_MULTIPLIER || "2.5");
const DAILY_SUMMARY_HOUR_DEFAULT = parseInt(process.env.DAILY_SUMMARY_HOUR || "9", 10);
const MARKET_WIDE_THRESHOLD_DEFAULT = parseFloat(process.env.MARKET_WIDE_THRESHOLD || "2.5");
const BREAKOUT_MIN_PERCENT_DEFAULT = parseFloat(process.env.BREAKOUT_MIN_PERCENT || "1");
const PIVOT_REFRESH_HOURS = parseFloat(process.env.PIVOT_REFRESH_HOURS || "4");
const PIVOT_HYSTERESIS_DEFAULT = parseFloat(process.env.PIVOT_HYSTERESIS_PERCENT || "0.5");
const BTC_ID = "bitcoin";
const ENV_BLACKLIST = (process.env.BLACKLIST_IDS || "").split(",").map((s)=>s.trim()).filter(Boolean);

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error("خطا: TELEGRAM_BOT_TOKEN و TELEGRAM_CHAT_ID رو تنظیم کن (راهنما در README.md).");
  process.exit(1);
}

// ---------------- حالت قابل‌تغییر + ذخیره‌سازی ----------------
const STATE_DIR = process.env.STATE_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname; // اگه Volume وصل باشه، خودکار همون مسیر استفاده می‌شه
const STATE_FILE = path.join(STATE_DIR, "state.json");
let state = {
  threshold: parseFloat(process.env.THRESHOLD_PERCENT || "5"),
  dumpThreshold: -Math.abs(parseFloat(process.env.DUMP_THRESHOLD_PERCENT || "5")),
  paused: false,
  watchlist: [],
  blacklist: DEFAULT_BLACKLIST.concat(ENV_BLACKLIST),
  history: [], // [{t, type, symbol, name, detail, id, price}]
  priceAlerts: [], // [{uid, coinId, symbol, name, target, dir, createdAt}]
  nextAlertId: 1,
  dynamicEnabled: true,
  dynamicFactor: DYNAMIC_THRESHOLD_FACTOR_DEFAULT,
  volumeAlertEnabled: true,
  volumeSpikeMultiplier: VOLUME_SPIKE_MULTIPLIER_DEFAULT,
  mutes: [], // [{id, symbol, until}]
  dailySummaryEnabled: true,
  dailySummaryHour: DAILY_SUMMARY_HOUR_DEFAULT,
  lastSummaryDate: null,
  marketWideThreshold: MARKET_WIDE_THRESHOLD_DEFAULT,
  newEntrantEnabled: true,
  breakoutAlertEnabled: true,
  breakoutMinPercent: BREAKOUT_MIN_PERCENT_DEFAULT,
  pivotAlertEnabled: true,
  pivotHysteresisPercent: PIVOT_HYSTERESIS_DEFAULT,
};
function loadState() {
  try {
    state = Object.assign(state, JSON.parse(fs.readFileSync(STATE_FILE, "utf8")));
    console.log("تنظیمات قبلی از فایل بارگذاری شد.");
  } catch (e) { console.log("فایل تنظیمات قبلی پیدا نشد؛ از مقادیر پیش‌فرض استفاده می‌شه."); }
}
function saveState() {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) { console.error("خطا در ذخیره‌ی تنظیمات:", e.message); }
}
loadState();

const history = new Map();
const meta = new Map();
const notifiedPump = new Map();
const notifiedDump = new Map();
const notifiedVolume = new Map();
const prevExtremes = new Map(); // id -> {high, low}  (برای تشخیص شکست سقف/کف ۲۴ ساعته)
const pivotLevels = new Map();     // id -> {levels:{P,R1,R2,R3,S1,S2,S3}, computedAt}
const pivotCrossState = new Map(); // id -> {R1:"above"|"below", ...}
let previousTopIds = new Set();  // برای تشخیص ورود تازه به لیست برتر
let topBaselineEstablished = false;
const volatilityEma = new Map();  // id -> EMA میانگین قدرمطلق تغییر ۲۴ ساعته (شاخص نوسان معمول کوین)
const volumeEma = new Map();      // id -> EMA حجم ۲۴ ساعته (پایه برای تشخیص جهش حجم)
const sampleCount = new Map();    // id -> تعداد نمونه‌ی دیده‌شده (برای اطمینان از پایدار بودن EMA)

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
function fmtDateTime(ts) { return new Date(ts).toLocaleString("fa-IR", { timeZone: TIMEZONE }); }
function fmtTimeOnly(ts) { return new Date(ts).toLocaleTimeString("fa-IR", { timeZone: TIMEZONE }); }
const PUMP_ICON1 = "🌲"; // آیکون فشرده (لیست‌ها، دکمه‌ها، تاریخچه)
const DUMP_ICON1 = "🔻";
const PUMP_ICON = PUMP_ICON1.repeat(3); // آیکون درشت (هدر و خطوط اصلی هشدار پامپ/دامپ)
const DUMP_ICON = DUMP_ICON1.repeat(3);
function chartLink(id) { return `https://www.coingecko.com/en/coins/${id}`; }
function fmtPrice(p) {
  if (p == null || isNaN(p)) return "—";
  if (p >= 1000) return p.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (p >= 1) return p.toLocaleString("en-US", { maximumFractionDigits: 4 });
  return p.toLocaleString("en-US", { maximumSignificantDigits: 4, maximumFractionDigits: 10 });
}

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
function editMessage(chatId, messageId, text, keyboard) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`;
  const body = { chat_id: chatId, message_id: messageId, text: text };
  if (keyboard) body.reply_markup = { inline_keyboard: keyboard };
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch((err) => console.error("خطا در ویرایش پیام تلگرام:", err.message));
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
function confidenceScore(m, changeAbs, trend, marketCtx) {
  let score = 0;
  if (m.volume >= MIN_VOLUME_USD * 5) score += 20;
  else if (m.volume >= MIN_VOLUME_USD * 2) score += 10;

  if (m.rank && m.rank <= 100) score += 20;
  else if (m.rank && m.rank <= 300) score += 10;
  else if (m.rank && m.rank <= 500) score += 4;

  if (m.marketCap && m.marketCap > 0) {
    const turnover = m.volume / m.marketCap;
    if (turnover > 0.15) score += 12;
    else if (turnover > 0.07) score += 6;
  }

  if (changeAbs >= 5 && changeAbs <= 25) score += 12;
  else if (changeAbs > 25) score += 5;

  let trendLine = "روند ۴ ساعته: نامشخص";
  if (trend && trend.known) {
    if (trend.aligned) { score += 16; trendLine = "روند ۴ ساعته: هم‌جهت ✅"; }
    else if (trend.opposite) { score -= 8; trendLine = "روند ۴ ساعته: مخالف ⚠️"; }
    else trendLine = "روند ۴ ساعته: مبهم";
  }

  let marketLine = null;
  if (marketCtx && marketCtx.known) {
    if (marketCtx.correlated) { score -= 12; marketLine = "وضعیت بازار: هم‌جهت با کل بازار ⚠️"; }
    else { score += 8; marketLine = "وضعیت بازار: مستقل از بازار ✅"; }
  }

  score = Math.max(0, Math.min(100, score));
  const label = score >= 70 ? "قوی 🟢" : score >= 40 ? "متوسط 🟡" : "ضعیف 🔴";
  return { score, label, trendLine, marketLine };
}
function getMarketContext(id, coinChangeAbs, direction) {
  if (id === BTC_ID) return null; // مقایسه‌ی بیت‌کوین با خودش بی‌معنیه
  const btcArr = history.get(BTC_ID);
  if (!btcArr || btcArr.length < 2) return { known: false };
  const { changes: btcChanges } = computeChanges(btcArr, Date.now());
  const vals = Object.values(btcChanges).filter((v) => v != null);
  if (!vals.length) return { known: false };
  const btcMove = direction === "up" ? Math.max.apply(null, vals) : Math.min.apply(null, vals);
  const sameDirection = direction === "up" ? btcMove > 0 : btcMove < 0;
  const correlated = sameDirection && Math.abs(btcMove) >= state.marketWideThreshold;
  return { known: true, correlated, btcMove };
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
  const bases = {};
  for (const w of WINDOWS_MINUTES) {
    const windowMs = w * 60 * 1000;
    let base = arr[0];
    for (let i = 0; i < arr.length; i++) {
      if (now - arr[i].t <= windowMs) { base = arr[i]; break; }
      base = arr[i];
    }
    changes[w] = (base && base.p > 0) ? ((arr[arr.length - 1].p - base.p) / base.p) * 100 : null;
    bases[w] = base;
  }
  return { changes, bases };
}
function pushHistoryLog(type, symbol, name, detail, id, price, changePct) {
  state.history.unshift({ t: Date.now(), type, symbol, name, detail, id, price, changePct });
  if (state.history.length > 500) state.history.length = 500;
  saveState();
}

// ---------------- آستانه‌ی پویا، سکوت موقت، و جهش حجم ----------------
function updateBaselines(c, now) {
  const id = c.id;
  const chg24h = typeof c.price_change_percentage_24h === "number" ? Math.abs(c.price_change_percentage_24h) : null;
  const vol = c.total_volume || 0;
  const n = (sampleCount.get(id) || 0) + 1;
  sampleCount.set(id, n);
  const alpha = n < 10 ? 1 / n : 0.1; // شروع سریع، بعد پایدار
  if (chg24h != null) {
    const prevV = volatilityEma.get(id);
    volatilityEma.set(id, prevV == null ? chg24h : prevV + alpha * (chg24h - prevV));
  }
  const prevVol = volumeEma.get(id);
  volumeEma.set(id, prevVol == null ? vol : prevVol + alpha * (vol - prevVol));
}
function effectiveThresholds(id) {
  let pump = state.threshold, dump = state.dumpThreshold;
  if (state.dynamicEnabled) {
    const baseline = volatilityEma.get(id);
    const n = sampleCount.get(id) || 0;
    if (baseline != null && n >= 5) {
      const scaled = baseline * state.dynamicFactor;
      pump = Math.max(state.threshold, scaled);
      dump = -Math.max(Math.abs(state.dumpThreshold), scaled);
    }
  }
  return { pump, dump };
}
function cleanupMutes(now) {
  const before = state.mutes.length;
  state.mutes = state.mutes.filter((m) => m.until > now);
  if (state.mutes.length !== before) saveState();
}
function isMuted(id, now) { return state.mutes.some((m) => m.id === id && m.until > now); }
function parseDuration(text) {
  const m = String(text).trim().match(/^(\d+(?:\.\d+)?)\s*(m|min|h|d)?$/i);
  if (!m) return null;
  const val = parseFloat(m[1]);
  const unit = (m[2] || "h").toLowerCase();
  const mult = unit === "d" ? 24 * 3600000 : unit === "m" || unit === "min" ? 60000 : 3600000;
  const ms = val * mult;
  return ms > 0 ? ms : null;
}

// ---------------- ورود تازه به لیست برتر ----------------
function checkNewEntrants(rankedIds) {
  if (topBaselineEstablished && state.newEntrantEnabled) {
    for (const id of rankedIds) {
      if (previousTopIds.has(id)) continue;
      if (state.blacklist.includes(id)) continue;
      const now = Date.now();
      if (isMuted(id, now)) continue;
      const m = meta.get(id);
      if (!m) continue;
      sendTelegram(
        `🆕 ورود تازه به لیست برتر: ${m.symbol.toUpperCase()} (${m.name})\n` +
        `رتبه‌ی فعلی: #${m.rank || "—"}\n` +
        `قیمت: $${fmtPrice(history.get(id) ? history.get(id).slice(-1)[0].p : null)}\n` +
        `حجم ۲۴ ساعته: $${fmtNum(m.volume)}\n` +
        `ممکنه نشونه‌ی یه رشد یا لیستینگ مهم باشه.`,
        [[{ text: "📈 نمودار", url: chartLink(id) }]]
      );
      pushHistoryLog("ورود", m.symbol.toUpperCase(), m.name, `${m.symbol.toUpperCase()} وارد لیست برتر شد (#${m.rank})`, id, null, null);
      console.log(`[NEW ENTRANT] ${m.symbol.toUpperCase()} #${m.rank}`);
    }
  }
  previousTopIds = new Set(rankedIds);
  topBaselineEstablished = true;
}

// ---------------- مقاومت/حمایت (Pivot Points) برای لیست ویژه ----------------
function computePivots(candles) {
  const last = (candles || []).slice(-6); // تقریباً ۲۴ ساعت اخیر (۶ کندل ۴ساعته)
  if (last.length < 3) return null;
  const high = Math.max.apply(null, last.map((c) => c[2]));
  const low = Math.min.apply(null, last.map((c) => c[3]));
  const close = last[last.length - 1][4];
  const P = (high + low + close) / 3;
  return {
    P,
    R1: 2 * P - low, S1: 2 * P - high,
    R2: P + (high - low), S2: P - (high - low),
    R3: high + 2 * (P - low), S3: low - 2 * (high - P),
  };
}
async function ensurePivotLevels(id) {
  const cached = pivotLevels.get(id);
  const now = Date.now();
  if (cached && now - cached.computedAt < PIVOT_REFRESH_HOURS * 3600000) return cached.levels;
  try {
    const candles = await fetchOHLC4h(id);
    const levels = computePivots(candles);
    if (levels) { pivotLevels.set(id, { levels, computedAt: now }); return levels; }
  } catch (e) { /* از مقدار قبلی (اگه بود) استفاده می‌شه */ }
  return cached ? cached.levels : null;
}
const PIVOT_LABELS = { R1: "مقاومت اول", R2: "مقاومت دوم", R3: "مقاومت سوم", S1: "حمایت اول", S2: "حمایت دوم", S3: "حمایت سوم" };
async function checkPivotCrossings(id, price, symbol, name) {
  if (!state.pivotAlertEnabled) return;
  const levels = await ensurePivotLevels(id);
  if (!levels) return;
  const prevState = pivotCrossState.get(id);
  const newState = {};
  for (const key of ["R1", "R2", "R3", "S1", "S2", "S3"]) {
    const level = levels[key];
    const band = level * (state.pivotHysteresisPercent / 100);
    const isResistance = key[0] === "R";

    if (!prevState) {
      // اولین باری که این کوین رو می‌بینیم: فقط baseline ثبت می‌شه، هشدار داده نمی‌شه
      newState[key] = price >= level ? "above" : "below";
      continue;
    }

    const prevSide = prevState[key];
    if (isResistance) {
      if (prevSide !== "above" && price >= level) {
        newState[key] = "above";
        sendTelegram(
          `${PUMP_ICON1} شکست ${PIVOT_LABELS[key]}: ${symbol.toUpperCase()} (${name}) ⭐\n` +
          `قیمت از سطح $${fmtPrice(level)} عبور کرد\nقیمت فعلی: $${fmtPrice(price)}`,
          [[{ text: "📈 نمودار", url: chartLink(id) }]]
        );
        pushHistoryLog("سطح", symbol.toUpperCase(), name, `${symbol.toUpperCase()} شکست ${PIVOT_LABELS[key]}`, id, price, null);
      } else if (prevSide === "above" && price < level - band) {
        newState[key] = "below"; // فقط آماده‌سازی دوباره، بدون هشدار
      } else {
        newState[key] = prevSide;
      }
    } else {
      if (prevSide !== "below" && price < level) {
        newState[key] = "below";
        sendTelegram(
          `${DUMP_ICON1} شکست ${PIVOT_LABELS[key]}: ${symbol.toUpperCase()} (${name}) ⭐\n` +
          `قیمت زیر سطح $${fmtPrice(level)} رفت\nقیمت فعلی: $${fmtPrice(price)}`,
          [[{ text: "📈 نمودار", url: chartLink(id) }]]
        );
        pushHistoryLog("سطح", symbol.toUpperCase(), name, `${symbol.toUpperCase()} شکست ${PIVOT_LABELS[key]}`, id, price, null);
      } else if (prevSide === "below" && price > level + band) {
        newState[key] = "above"; // فقط آماده‌سازی دوباره، بدون هشدار
      } else {
        newState[key] = prevSide;
      }
    }
  }
  pivotCrossState.set(id, newState);
}

// ---------------- شکست سقف/کف ۲۴ ساعته ----------------
function checkBreakout(c, now, isWatched) {
  if (!state.breakoutAlertEnabled) return;
  if (state.blacklist.includes(c.id) || isMuted(c.id, now)) return;
  if (!isWatched && (c.total_volume || 0) < MIN_VOLUME_USD) return;
  const newHigh = c.high_24h, newLow = c.low_24h;
  const prev = prevExtremes.get(c.id);
  if (prev) {
    if (newHigh != null && prev.high != null && newHigh > prev.high) {
      const pct = ((newHigh - prev.high) / prev.high) * 100;
      if (pct >= state.breakoutMinPercent) {
        sendTelegram(
          `${PUMP_ICON1} شکست سقف ۲۴ ساعته: ${c.symbol.toUpperCase()} (${c.name})\n` +
          `سقف قبلی: $${fmtPrice(prev.high)} ← سقف جدید: $${fmtPrice(newHigh)} (+${pct.toFixed(1)}٪)\n` +
          `قیمت فعلی: $${fmtPrice(c.current_price)}`,
          [[{ text: "📈 نمودار", url: chartLink(c.id) }, { text: "🚫 مسدود کن", callback_data: "blacklist:" + c.id }]]
        );
        pushHistoryLog("شکست", c.symbol.toUpperCase(), c.name, `${c.symbol.toUpperCase()} شکست سقف (+${pct.toFixed(1)}٪)`, c.id, c.current_price, pct);
        console.log(`[BREAKOUT-UP] ${c.symbol.toUpperCase()} +${pct.toFixed(1)}%`);
      }
    }
    if (newLow != null && prev.low != null && newLow < prev.low) {
      const pct = ((prev.low - newLow) / prev.low) * 100;
      if (pct >= state.breakoutMinPercent) {
        sendTelegram(
          `${DUMP_ICON1} شکست کف ۲۴ ساعته: ${c.symbol.toUpperCase()} (${c.name})\n` +
          `کف قبلی: $${fmtPrice(prev.low)} ← کف جدید: $${fmtPrice(newLow)} (-${pct.toFixed(1)}٪)\n` +
          `قیمت فعلی: $${fmtPrice(c.current_price)}`,
          [[{ text: "📈 نمودار", url: chartLink(c.id) }, { text: "🚫 مسدود کن", callback_data: "blacklist:" + c.id }]]
        );
        pushHistoryLog("شکست", c.symbol.toUpperCase(), c.name, `${c.symbol.toUpperCase()} شکست کف (-${pct.toFixed(1)}٪)`, c.id, c.current_price, -pct);
        console.log(`[BREAKOUT-DOWN] ${c.symbol.toUpperCase()} -${pct.toFixed(1)}%`);
      }
    }
  }
  prevExtremes.set(c.id, { high: newHigh, low: newLow });
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
    if (isMuted(id, now)) continue; // این کوین موقتاً ساکت شده

    const eff = effectiveThresholds(id);
    const { changes, bases } = computeChanges(arr, now);
    const vals = Object.values(changes).filter((v) => v != null);
    if (!vals.length) continue;
    const maxChange = Math.max.apply(null, vals);
    const minChange = Math.min.apply(null, vals);
    const latestPrice = arr[arr.length - 1].p;
    const nowTimeStr = fmtTimeOnly(now);

    const pumpWindows = WINDOWS_MINUTES.filter((w) => changes[w] != null && changes[w] >= eff.pump);
    const wasPump = notifiedPump.get(id) || false;
    if (pumpWindows.length) {
      if (!wasPump) {
        notifiedPump.set(id, true);
        const trend = await trendConfirmation(id, "up");
        const marketCtx = getMarketContext(id, maxChange, "up");
        const conf = confidenceScore(m, maxChange, trend, marketCtx);
        const lines = pumpWindows.map((w) => {
          const b = bases[w];
          return `${PUMP_ICON} ${w} دقیقه: +${changes[w].toFixed(1)}٪\n` +
            `   $${fmtPrice(b.p)} (${fmtTimeOnly(b.t)}) ← $${fmtPrice(latestPrice)} (${nowTimeStr})`;
        }).join("\n");
        const label = `${m.symbol.toUpperCase()} +${maxChange.toFixed(1)}٪`;
        sendTelegram(
          `${PUMP_ICON} پامپ شناسایی شد: ${m.symbol.toUpperCase()} (${m.name})${isWatched ? " ⭐" : ""}\n${lines}\n` +
          `قیمت فعلی: $${fmtPrice(latestPrice)} (${nowTimeStr})\n` +
          `حجم ۲۴ ساعته: $${fmtNum(m.volume)} | رتبه: #${m.rank || "—"}\n` +
          `${conf.trendLine}\n` +
          (conf.marketLine ? `${conf.marketLine}\n` : "") +
          `اطمینان: ${conf.label} (${conf.score}/100)`,
          [[{ text: "📈 نمودار", url: chartLink(id) }, { text: "🚫 مسدود کن", callback_data: "blacklist:" + id }]]
        );
        pushHistoryLog("پامپ", m.symbol.toUpperCase(), m.name, label, id, latestPrice, maxChange);
        console.log(`[PUMP] ${label}`);
      }
    } else if (maxChange < eff.pump - HYSTERESIS_PERCENT) {
      notifiedPump.set(id, false);
    }

    const dumpWindows = WINDOWS_MINUTES.filter((w) => changes[w] != null && changes[w] <= eff.dump);
    const wasDump = notifiedDump.get(id) || false;
    if (dumpWindows.length) {
      if (!wasDump) {
        notifiedDump.set(id, true);
        const trend = await trendConfirmation(id, "down");
        const marketCtx = getMarketContext(id, Math.abs(minChange), "down");
        const conf = confidenceScore(m, Math.abs(minChange), trend, marketCtx);
        const lines = dumpWindows.map((w) => {
          const b = bases[w];
          return `${DUMP_ICON} ${w} دقیقه: ${changes[w].toFixed(1)}٪\n` +
            `   $${fmtPrice(b.p)} (${fmtTimeOnly(b.t)}) ← $${fmtPrice(latestPrice)} (${nowTimeStr})`;
        }).join("\n");
        const label = `${m.symbol.toUpperCase()} ${minChange.toFixed(1)}٪`;
        sendTelegram(
          `${DUMP_ICON} افت شدید: ${m.symbol.toUpperCase()} (${m.name})${isWatched ? " ⭐" : ""}\n${lines}\n` +
          `قیمت فعلی: $${fmtPrice(latestPrice)} (${nowTimeStr})\n` +
          `حجم ۲۴ ساعته: $${fmtNum(m.volume)} | رتبه: #${m.rank || "—"}\n` +
          `${conf.trendLine}\n` +
          (conf.marketLine ? `${conf.marketLine}\n` : "") +
          `اطمینان: ${conf.label} (${conf.score}/100)`,
          [[{ text: "📈 نمودار", url: chartLink(id) }, { text: "🚫 مسدود کن", callback_data: "blacklist:" + id }]]
        );
        pushHistoryLog("دامپ", m.symbol.toUpperCase(), m.name, label, id, latestPrice, minChange);
        console.log(`[DUMP] ${label}`);
      }
    } else if (minChange > eff.dump + HYSTERESIS_PERCENT) {
      notifiedDump.set(id, false);
    }

    // --- جهش حجم معاملات (مستقل از حرکت قیمت) ---
    if (state.volumeAlertEnabled) {
      const baseline = volumeEma.get(id);
      const n = sampleCount.get(id) || 0;
      const ratio = baseline ? m.volume / baseline : null;
      const wasVol = notifiedVolume.get(id) || false;
      if (baseline && n >= 5 && ratio >= state.volumeSpikeMultiplier) {
        if (!wasVol) {
          notifiedVolume.set(id, true);
          const pct = (ratio - 1) * 100;
          const label = `${m.symbol.toUpperCase()} حجم ${ratio.toFixed(1)}× معمول`;
          sendTelegram(
            `📢 جهش حجم معاملات: ${m.symbol.toUpperCase()} (${m.name})${isWatched ? " ⭐" : ""}\n` +
            `حجم فعلی ${ratio.toFixed(1)} برابر میانگین معمول این کوینه (بدون نیاز به حرکت قیمت)\n` +
            `قیمت فعلی: $${fmtPrice(latestPrice)}\n` +
            `حجم ۲۴ ساعته: $${fmtNum(m.volume)} | رتبه: #${m.rank || "—"}`,
            [[{ text: "📈 نمودار", url: chartLink(id) }, { text: "🚫 مسدود کن", callback_data: "blacklist:" + id }]]
          );
          pushHistoryLog("حجم", m.symbol.toUpperCase(), m.name, label, id, latestPrice, pct);
          console.log(`[VOLUME] ${label}`);
        }
      } else if (ratio != null && ratio < state.volumeSpikeMultiplier * 0.7) {
        notifiedVolume.set(id, false);
      }
    }
  }
}

// ---------------- حلقه‌ی اصلی رصد بازار ----------------
async function pollOnce() {
  const hasPriceAlerts = state.priceAlerts.length > 0;
  if (state.paused && !hasPriceAlerts) return;
  const now = Date.now();
  const seen = new Set();
  try {
    const rankedIds = [];
    if (!state.paused) {
      for (let p = 1; p <= PAGES; p++) {
        const coins = await fetchMarketsPage(p);
        for (const c of coins) {
          if (!c.current_price) continue;
          meta.set(c.id, { name: c.name, symbol: c.symbol, volume: c.total_volume || 0, rank: c.market_cap_rank, marketCap: c.market_cap || 0, change24h: c.price_change_percentage_24h });
          pushPrice(c.id, c.current_price, now);
          updateBaselines(c, now);
          checkBreakout(c, now, state.watchlist.some((w) => w.id === c.id));
          seen.add(c.id);
          rankedIds.push(c.id);
        }
        if (p < PAGES) await sleep(2000);
      }
      checkNewEntrants(rankedIds);
    }
    // کوین‌هایی که آلارم قیمت یا واچ‌لیست دارن ولی توی صفحات بالا نبودن، هر بار جدا به‌روز می‌شن
    const wanted = new Set(state.priceAlerts.map((a) => a.coinId));
    if (!state.paused) state.watchlist.forEach((w) => wanted.add(w.id));
    const missing = Array.from(wanted).filter((id) => !seen.has(id));
    if (missing.length) {
      if (seen.size) await sleep(1200);
      const extra = await fetchMarketsByIds(missing);
      for (const c of extra) {
        if (!c.current_price) continue;
        meta.set(c.id, { name: c.name, symbol: c.symbol, volume: c.total_volume || 0, rank: c.market_cap_rank, marketCap: c.market_cap || 0, change24h: c.price_change_percentage_24h });
        pushPrice(c.id, c.current_price, now);
        updateBaselines(c, now);
        checkBreakout(c, now, true); // این حلقه فقط برای واچ‌لیست/کوین‌های گم‌شده‌ست
        seen.add(c.id);
      }
    }
    cleanupMutes(now);
    if (!state.paused) await evaluate(now);
    for (const w of state.watchlist) {
      const arr = history.get(w.id);
      if (arr && arr.length) await checkPivotCrossings(w.id, arr[arr.length - 1].p, w.symbol, w.name);
    }
    checkPriceAlerts(now);
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

// ---------------- آلارم‌های قیمت (چندتا برای هر کوین) ----------------
function checkPriceAlerts(now) {
  if (!state.priceAlerts.length) return;
  const triggered = [];
  const remaining = [];
  for (const a of state.priceAlerts) {
    const arr = history.get(a.coinId);
    const last = arr && arr.length ? arr[arr.length - 1] : null;
    if (!last || last.t !== now) { remaining.push(a); continue; } // داده‌ی تازه نداریم
    const hit = a.dir === "above" ? last.p >= a.target : last.p <= a.target;
    if (hit) triggered.push({ a, price: last.p });
    else remaining.push(a);
  }
  if (!triggered.length) return;
  state.priceAlerts = remaining;
  saveState();
  for (const { a, price } of triggered) {
    const left = remaining.filter((x) => x.coinId === a.coinId).length;
    const arrow = a.dir === "above" ? `${PUMP_ICON1} بالاتر از` : `${DUMP_ICON1} پایین‌تر از`;
    let title = "🔔 آلارم قیمت";
    if (a.kind === "stoploss") title = "🛑 حد ضرر فعال شد";
    else if (a.kind === "takeprofit") title = "🎯 حد سود فعال شد";
    sendTelegram(
      `${title}: ${a.symbol.toUpperCase()} (${a.name})${a.kind ? " ⭐" : ""}\n` +
      `${arrow} $${fmtPrice(a.target)} رسید\n` +
      `قیمت فعلی: $${fmtPrice(price)}\n` +
      `آلارم‌های باقی‌مانده‌ی ${a.symbol.toUpperCase()}: ${left}`,
      [[{ text: "📈 نمودار", url: chartLink(a.coinId) }]]
    );
    const logType = a.kind === "stoploss" ? "حدضرر" : a.kind === "takeprofit" ? "حدسود" : "قیمت";
    pushHistoryLog(logType, a.symbol.toUpperCase(), a.name, `${a.symbol.toUpperCase()} ${a.dir === "above" ? PUMP_ICON1 : DUMP_ICON1} ${fmtPrice(a.target)}`, a.coinId, price);
    console.log(`[PRICE ALERT] ${a.symbol.toUpperCase()} ${a.dir} ${a.target}`);
  }
}

function normalizeInput(s) {
  let out = String(s)
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06F0))
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/\u066C/g, ",")
    .replace(/\u066B/g, ".");
  let prev;
  do { prev = out; out = out.replace(/(\d),(\d{3})(?!\d)/g, "$1$2"); } while (out !== prev);
  return out;
}

async function cmdAlert(parts) {
  const usage = "مثال: /alert BTC 70000 75000 60000\n" +
    "برای اجباری‌کردن جهت یه قیمت خاص: above یا below رو درست قبل همون قیمت بذار،\n" +
    "مثلاً: /alert BTC above 70000 below 60000\n" +
    "بدون این کلمه‌ها، جهت هر قیمت خودکار نسبت به قیمت فعلی تشخیص داده می‌شه.";
  if (parts.length < 3) { sendTelegram(usage); return; }
  const tokens = normalizeInput(parts.slice(2).join(" ")).split(/\s+/).filter(Boolean);
  let pendingDir = null;
  const entries = []; // {price, dirOverride}
  const invalid = [];
  for (const tok of tokens) {
    const low = tok.toLowerCase();
    if (low === "above" || tok === "بالا") { pendingDir = "above"; continue; }
    if (low === "below" || tok === "پایین") { pendingDir = "below"; continue; }
    if (/^\d*\.?\d+$/.test(tok) && parseFloat(tok) > 0) {
      entries.push({ price: parseFloat(tok), dirOverride: pendingDir });
      pendingDir = null;
      continue;
    }
    invalid.push(tok);
  }
  if (invalid.length) { sendTelegram("قیمت نامعتبر: " + invalid.join("، ") + "\nاز نقطه برای اعشار استفاده کن و قیمت‌ها رو با فاصله جدا کن.\n" + usage); return; }
  if (!entries.length) { sendTelegram(usage); return; }
  if (entries.length > 10) { sendTelegram("حداکثر ۱۰ قیمت در هر دستور."); return; }

  const found = await resolveSymbolToId(parts[1]);
  if (!found) { sendTelegram("کوینی با این نماد پیدا نشد."); return; }
  let current = null;
  try {
    const data = await fetchMarketsByIds([found.id]);
    current = data[0] && data[0].current_price;
  } catch (e) { /* ignore */ }
  if (current == null) { sendTelegram("نتونستم قیمت فعلی رو بگیرم؛ چند لحظه‌ی دیگه دوباره امتحان کن."); return; }

  const added = [];
  const skipped = [];
  for (const entry of entries) {
    const price = entry.price;
    const dir = entry.dirOverride || (price > current ? "above" : "below");
    if (dir === "above" && price <= current) { skipped.push(`${fmtPrice(price)} (قیمت فعلی از این بالاتره)`); continue; }
    if (dir === "below" && price >= current) { skipped.push(`${fmtPrice(price)} (قیمت فعلی از این پایین‌تره)`); continue; }
    const dup = state.priceAlerts.some((a) => a.coinId === found.id && a.dir === dir && Math.abs(a.target - price) / price < 1e-9);
    if (dup) { skipped.push(`${fmtPrice(price)} (از قبل ثبت شده)`); continue; }
    state.priceAlerts.push({ uid: state.nextAlertId++, coinId: found.id, symbol: found.symbol, name: found.name, target: price, dir, createdAt: Date.now() });
    added.push(`${dir === "above" ? PUMP_ICON1 : DUMP_ICON1} ${fmtPrice(price)}`);
  }
  saveState();
  const existing = state.priceAlerts.filter((a) => a.coinId === found.id).length;
  let msg = "";
  if (added.length) msg += `✅ آلارم قیمت ${found.symbol.toUpperCase()} ثبت شد:\n${added.join("\n")}\nقیمت فعلی: $${fmtPrice(current)}\nمجموع آلارم‌های فعال ${found.symbol.toUpperCase()}: ${existing}`;
  if (skipped.length) msg += (msg ? "\n\n" : "") + "⚠️ ثبت نشد:\n" + skipped.join("\n");
  sendTelegram(msg);
}

function buildAlertsView(parts) {
  let list = state.priceAlerts;
  let title = "🔔 آلارم‌های قیمت";
  if (parts && parts[1]) {
    const sym = parts[1].toUpperCase();
    list = list.filter((a) => a.symbol.toUpperCase() === sym);
    title += " " + sym;
  }
  if (!list.length) return { text: "آلارم قیمتی ثبت نشده. برای ثبت: /alert BTC 70000", keyboard: null };
  const groups = {};
  list.forEach((a) => { const k = a.symbol.toUpperCase(); (groups[k] = groups[k] || []).push(a); });
  const lines = Object.keys(groups).map((k) =>
    `${k}: ` + groups[k].slice().sort((x, y) => y.target - x.target).map((a) => `${a.dir === "above" ? PUMP_ICON1 : DUMP_ICON1} ${fmtPrice(a.target)}`).join("  ")
  );
  const keyboard = [];
  let row = [];
  list.slice(0, 40).forEach((a) => {
    row.push({ text: `❌ ${a.symbol.toUpperCase()} ${a.dir === "above" ? PUMP_ICON1 : DUMP_ICON1}${fmtPrice(a.target)}`, callback_data: "delalert:" + a.uid });
    if (row.length === 2) { keyboard.push(row); row = []; }
  });
  if (row.length) keyboard.push(row);
  return { text: `${title}:\n${lines.join("\n")}\n\nبرای حذف، روی دکمه‌ی هر آلارم بزن.`, keyboard };
}
// ---------------- حد ضرر / حد سود (برای لیست ویژه) ----------------
function ensureWatched(found) {
  if (!state.watchlist.some((w) => w.id === found.id)) {
    state.watchlist.push(found);
    return true;
  }
  return false;
}
// ---------------- مشخصات کامل یه رمزارز (/profile) ----------------
async function fetchCoinFullStats(id) {
  const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${id}&price_change_percentage=1h,24h,7d`;
  const headers = {};
  if (COINGECKO_API_KEY) headers["x-cg-demo-api-key"] = COINGECKO_API_KEY;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error("coingecko_failed_" + res.status);
  const data = await res.json();
  return data[0] || null;
}
function candleTrendLabel(candles, n) {
  const last = (candles || []).slice(-n);
  if (last.length < 2) return "نامشخص";
  const startPrice = last[0][1]; // قیمت باز شدن اولین کندل
  const endPrice = last[last.length - 1][4]; // قیمت بسته شدن آخرین کندل
  if (!startPrice) return "نامشخص";
  const pct = ((endPrice - startPrice) / startPrice) * 100;
  if (pct > 1) return `صعودی 📈 (+${pct.toFixed(1)}٪)`;
  if (pct < -1) return `نزولی 📉 (${pct.toFixed(1)}٪)`;
  return `خنثی ↔️ (${pct >= 0 ? "+" : ""}${pct.toFixed(1)}٪)`;
}
function pctLabel(v) {
  if (v == null || isNaN(v)) return "نامشخص";
  const sign = v >= 0 ? "+" : "";
  return `${sign}${v.toFixed(1)}٪`;
}
async function cmdProfile(parts) {
  if (!parts[1]) { sendTelegram("مثال: /profile BTC"); return; }
  const found = await resolveSymbolToId(parts[1]);
  if (!found) { sendTelegram("کوینی با این نماد پیدا نشد."); return; }
  sendTelegram("در حال آماده‌سازی مشخصات...");

  let stats = null, candles = null, levels = null;
  try { stats = await fetchCoinFullStats(found.id); } catch (e) { /* ignore */ }
  try { candles = await fetchOHLC4h(found.id); } catch (e) { /* ignore */ }
  try { levels = await ensurePivotLevels(found.id); } catch (e) { /* ignore */ }

  if (!stats) { sendTelegram("نتونستم اطلاعات این کوین رو بگیرم؛ دوباره امتحان کن."); return; }

  const price = stats.current_price;
  const high24 = stats.high_24h, low24 = stats.low_24h;
  const chg1h = stats.price_change_percentage_1h_in_currency;
  const chg24h = stats.price_change_percentage_24h_in_currency != null ? stats.price_change_percentage_24h_in_currency : stats.price_change_percentage_24h;
  const chg7d = stats.price_change_percentage_7d_in_currency;
  const trend4h = candles ? candleTrendLabel(candles, 2) : "نامشخص";

  let text = `📋 مشخصات ${found.symbol.toUpperCase()} (${stats.name})\n\n`;
  text += `💰 قیمت فعلی: $${fmtPrice(price)}\n`;
  text += `رتبه‌ی بازار: #${stats.market_cap_rank || "—"}\n\n`;

  text += `📊 روندها:\n`;
  text += `  ۱ ساعت: ${pctLabel(chg1h)}\n`;
  text += `  ۴ ساعت (بر پایه کندل): ${trend4h}\n`;
  text += `  روزانه (۲۴ ساعت): ${pctLabel(chg24h)}\n`;
  text += `  هفتگی (۷ روز): ${pctLabel(chg7d)}\n\n`;

  if (high24 != null && low24 != null) {
    const distHigh = ((high24 - price) / high24) * 100;
    const distLow = ((price - low24) / low24) * 100;
    text += `↕️ بازه‌ی ۲۴ ساعته: سقف $${fmtPrice(high24)} | کف $${fmtPrice(low24)}\n`;
    text += `   (${distHigh.toFixed(1)}٪ پایین‌تر از سقف | ${distLow.toFixed(1)}٪ بالاتر از کف)\n\n`;
  }

  if (levels) {
    text += `🎯 مقاومت‌ها: R1 $${fmtPrice(levels.R1)} · R2 $${fmtPrice(levels.R2)} · R3 $${fmtPrice(levels.R3)}\n`;
    text += `🛡 حمایت‌ها: S1 $${fmtPrice(levels.S1)} · S2 $${fmtPrice(levels.S2)} · S3 $${fmtPrice(levels.S3)}\n\n`;
  } else {
    text += `🎯 مقاومت/حمایت: نتونستم محاسبه کنم\n\n`;
  }

  const sl = state.priceAlerts.find((a) => a.coinId === found.id && a.kind === "stoploss");
  const tp = state.priceAlerts.find((a) => a.coinId === found.id && a.kind === "takeprofit");
  if (sl || tp) {
    if (sl) text += `🛑 حد ضرر فعال: $${fmtPrice(sl.target)}\n`;
    if (tp) text += `🎯 حد سود فعال: $${fmtPrice(tp.target)}\n`;
    text += "\n";
  }

  text += `💧 حجم ۲۴ ساعته: $${fmtNum(stats.total_volume)}\n`;
  if (stats.market_cap) {
    const turnover = (stats.total_volume / stats.market_cap) * 100;
    text += `   نسبت حجم به ارزش‌بازار: ${turnover.toFixed(1)}٪\n`;
  }
  text += "\n";

  const btcMeta = meta.get(BTC_ID);
  if (found.id !== BTC_ID && btcMeta && btcMeta.change24h != null && chg24h != null) {
    const diff = chg24h - btcMeta.change24h;
    let rel;
    if (diff > 2) rel = `قوی‌تر از بیت‌کوین (+${diff.toFixed(1)}٪ نسبت به BTC) ✅`;
    else if (diff < -2) rel = `ضعیف‌تر از بیت‌کوین (${diff.toFixed(1)}٪ نسبت به BTC) ⚠️`;
    else rel = "تقریباً هم‌تراز با بیت‌کوین";
    text += `🌐 وضعیت نسبت به بازار: ${rel}\n\n`;
  }

  const isWatched = state.watchlist.some((w) => w.id === found.id);
  const isBlacklisted = state.blacklist.includes(found.id);
  const muteEntry = state.mutes.find((mm) => mm.id === found.id && mm.until > Date.now());
  let statusLine = isWatched ? "⭐ توی لیست ویژه" : "توی لیست ویژه نیست";
  if (isBlacklisted) statusLine += " | 🚫 مسدود";
  if (muteEntry) statusLine += ` | 🔇 ساکت تا ${fmtDateTime(muteEntry.until)}`;
  text += `وضعیت در ربات: ${statusLine}\n\n`;
  text += `این فقط خلاصه‌ی داده‌هاست، نه توصیه‌ی خرید یا فروش.`;

  sendTelegram(text, [[{ text: "📈 نمودار", url: chartLink(found.id) }]]);
}

async function cmdStopOrTake(parts, kind) {
  const label = kind === "stoploss" ? "حد ضرر" : "حد سود";
  const usage = kind === "stoploss"
    ? "مثال: /stoploss BTC 60000  (باید پایین‌تر از قیمت فعلی باشه)"
    : "مثال: /takeprofit BTC 80000  (باید بالاتر از قیمت فعلی باشه)";
  if (!parts[1] || !parts[2]) { sendTelegram(usage); return; }
  const priceText = normalizeInput(parts[2]);
  if (!/^\d*\.?\d+$/.test(priceText) || parseFloat(priceText) <= 0) { sendTelegram("قیمت نامعتبر.\n" + usage); return; }
  const price = parseFloat(priceText);

  const found = await resolveSymbolToId(parts[1]);
  if (!found) { sendTelegram("کوینی با این نماد پیدا نشد."); return; }
  let current = null;
  try {
    const data = await fetchMarketsByIds([found.id]);
    current = data[0] && data[0].current_price;
  } catch (e) { /* ignore */ }
  if (current == null) { sendTelegram("نتونستم قیمت فعلی رو بگیرم؛ چند لحظه‌ی دیگه دوباره امتحان کن."); return; }

  const dir = kind === "stoploss" ? "below" : "above";
  if (dir === "below" && price >= current) { sendTelegram(`${label} باید پایین‌تر از قیمت فعلی ($${fmtPrice(current)}) باشه.`); return; }
  if (dir === "above" && price <= current) { sendTelegram(`${label} باید بالاتر از قیمت فعلی ($${fmtPrice(current)}) باشه.`); return; }

  const dup = state.priceAlerts.some((a) => a.coinId === found.id && a.kind === kind);
  if (dup) { sendTelegram(`${label}ی برای ${found.symbol.toUpperCase()} از قبل ثبت شده. اول با /delalert پاکش کن.`); return; }

  const addedToWatch = ensureWatched(found);
  state.priceAlerts.push({ uid: state.nextAlertId++, coinId: found.id, symbol: found.symbol, name: found.name, target: price, dir, createdAt: Date.now(), kind });
  saveState();
  sendTelegram(
    `✅ ${label} ${found.symbol.toUpperCase()} روی $${fmtPrice(price)} ثبت شد.\n` +
    `قیمت فعلی: $${fmtPrice(current)}` +
    (addedToWatch ? `\n⭐ ${found.symbol.toUpperCase()} به لیست ویژه (واچ‌لیست) هم اضافه شد.` : "")
  );
}

function cmdAlerts(parts) {
  const v = buildAlertsView(parts);
  sendTelegram(v.text, v.keyboard);
}

function cmdDelAlert(parts) {
  if (!parts[1]) { sendTelegram("مثال: /delalert BTC 70000\nیا فقط /delalert BTC برای حذف همه‌ی آلارم‌های اون کوین"); return; }
  const sym = parts[1].toUpperCase();
  const nums = parts.length > 2
    ? normalizeInput(parts.slice(2).join(" ")).split(/\s+/).map(parseFloat).filter((n) => !isNaN(n))
    : [];
  const before = state.priceAlerts.length;
  state.priceAlerts = state.priceAlerts.filter((a) => {
    if (a.symbol.toUpperCase() !== sym) return true;
    if (!nums.length) return false;
    return !nums.some((n) => Math.abs(n - a.target) / a.target < 1e-9);
  });
  const removed = before - state.priceAlerts.length;
  saveState();
  sendTelegram(removed ? `🗑 ${removed} آلارم ${sym} حذف شد.` : "آلارمی با این مشخصات پیدا نشد.");
}

// ---------------- گزارش هشدارهای یک کوین ----------------
async function coinReport(symbolRaw, days) {
  const symbol = symbolRaw.toUpperCase();
  const cutoff = Date.now() - days * 86400000;
  const items = state.history.filter((h) => h.symbol && h.symbol.toUpperCase() === symbol && h.t >= cutoff);
  const active = state.priceAlerts.filter((a) => a.symbol.toUpperCase() === symbol);
  if (!items.length && !active.length) return `برای ${symbol} توی ${days} روز اخیر هشداری ثبت نشده.`;

  const coinId = (items[0] && items[0].id) || (active[0] && active[0].coinId);
  let current = null;
  if (coinId) {
    try { const d = await fetchMarketsByIds([coinId]); current = d[0] && d[0].current_price; } catch (e) { /* ignore */ }
  }
  const pumps = items.filter((h) => h.type === "پامپ");
  const dumps = items.filter((h) => h.type === "دامپ");
  const priceHits = items.filter((h) => h.type === "قیمت");

  let text = `📋 گزارش ${symbol} — ${days} روز اخیر\n`;
  text += `🚀 پامپ: ${pumps.length} | 🔻 دامپ: ${dumps.length} | 🔔 آلارم قیمت فعال‌شده: ${priceHits.length}\n`;
  if (current != null) text += `قیمت فعلی: $${fmtPrice(current)}\n`;
  text += "\n";

  const lines = items.slice(0, 15).map((h) => {
    const icon = h.type === "پامپ" ? PUMP_ICON1 : h.type === "دامپ" ? DUMP_ICON1 : h.type === "ورود" ? "🆕" : h.type === "شکست" ? ((h.changePct || 0) >= 0 ? PUMP_ICON1 : DUMP_ICON1) : h.type === "سطح" ? "📊" : h.type === "حدضرر" ? "🛑" : h.type === "حدسود" ? "🎯" : "🔔";
    let outcome = "";
    if (h.type !== "قیمت" && current != null && h.price) {
      const pct = ((current - h.price) / h.price) * 100;
      outcome = ` → الان ${pct >= 0 ? "+" : ""}${pct.toFixed(1)}٪`;
    }
    return `${icon} ${h.detail} | $${fmtPrice(h.price)}${outcome}\n    ${fmtDateTime(h.t)}`;
  });
  if (lines.length) text += lines.join("\n") + "\n";
  if (items.length > 15) text += `... و ${items.length - 15} مورد قدیمی‌تر\n`;

  if (current != null) {
    const okPumps = pumps.filter((h) => h.price && current > h.price).length;
    const okDumps = dumps.filter((h) => h.price && current < h.price).length;
    if (pumps.length) text += `\nاز ${pumps.length} پامپ، ${okPumps} مورد هنوز بالاتر از قیمت هشدار مونده.`;
    if (dumps.length) text += `\nاز ${dumps.length} دامپ، ${okDumps} مورد هنوز پایین‌تر از قیمت هشدار مونده.`;
  }
  if (active.length) {
    text += `\n\n🔔 آلارم‌های قیمت فعال: ` + active.slice().sort((x, y) => y.target - x.target).map((a) => `${a.dir === "above" ? PUMP_ICON1 : DUMP_ICON1} ${fmtPrice(a.target)}`).join("  ");
  }
  return text;
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

// ---------------- خروجی CSV ----------------
async function sendCsvExport(days) {
  const cutoff = Date.now() - days * 86400000;
  const rows = state.history.filter((h) => h.t >= cutoff);
  if (!rows.length) { sendTelegram("داده‌ای برای خروجی گرفتن توی این بازه پیدا نشد."); return; }
  let csv = "time_utc,type,symbol,name,detail,price,change_percent\n";
  const esc = (s) => String(s == null ? "" : s).replace(/"/g, '""').replace(/\n/g, " ");
  for (const h of rows) {
    csv += [new Date(h.t).toISOString(), h.type, h.symbol, `"${esc(h.name)}"`, `"${esc(h.detail)}"`, h.price ?? "", h.changePct != null ? h.changePct.toFixed(2) : ""].join(",") + "\n";
  }
  try {
    const blob = new Blob([csv], { type: "text/csv" });
    const form = new FormData();
    form.append("chat_id", TELEGRAM_CHAT_ID);
    form.append("document", blob, `pumpyab-history-${days}d.csv`);
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendDocument`;
    const res = await fetch(url, { method: "POST", body: form });
    if (!res.ok) sendTelegram("خطا در ارسال فایل CSV.");
  } catch (e) {
    sendTelegram("خطا در ارسال فایل CSV: " + e.message);
  }
}

// ---------------- خلاصه‌ی روزانه ----------------
function tehranDateKey(now) {
  return new Date(now).toLocaleDateString("en-CA", { timeZone: TIMEZONE }); // YYYY-MM-DD
}
function buildDailySummaryText() {
  const cutoff = Date.now() - 24 * 3600000;
  const items = state.history.filter((h) => h.t >= cutoff);
  const pumps = items.filter((h) => h.type === "پامپ");
  const dumps = items.filter((h) => h.type === "دامپ");
  const vols = items.filter((h) => h.type === "حجم");
  const priceHits = items.filter((h) => h.type === "قیمت");
  const entrants = items.filter((h) => h.type === "ورود");
  const breakouts = items.filter((h) => h.type === "شکست");
  const levelCrosses = items.filter((h) => h.type === "سطح");
  const stopHits = items.filter((h) => h.type === "حدضرر");
  const takeHits = items.filter((h) => h.type === "حدسود");
  let text = "🗓 خلاصه‌ی ۲۴ ساعت اخیر\n\n";
  text += `${PUMP_ICON1} پامپ: ${pumps.length} | ${DUMP_ICON1} دامپ: ${dumps.length} | 📢 جهش حجم: ${vols.length} | 🔔 آلارم قیمت: ${priceHits.length}\n`;
  text += `🆕 ورود تازه: ${entrants.length} | 📊 شکست سقف/کف: ${breakouts.length} | ⭐ شکست مقاومت/حمایت: ${levelCrosses.length}\n`;
  if (stopHits.length || takeHits.length) text += `🛑 حد ضرر فعال‌شده: ${stopHits.length} | 🎯 حد سود فعال‌شده: ${takeHits.length}\n`;
  const topPump = pumps.slice().sort((a, b) => (b.changePct || 0) - (a.changePct || 0))[0];
  const topDump = dumps.slice().sort((a, b) => (a.changePct || 0) - (b.changePct || 0))[0];
  const topVol = vols.slice().sort((a, b) => (b.changePct || 0) - (a.changePct || 0))[0];
  if (topPump) text += `\nبیشترین رشد: ${topPump.symbol} (+${(topPump.changePct || 0).toFixed(1)}٪)`;
  if (topDump) text += `\nبیشترین افت: ${topDump.symbol} (${(topDump.changePct || 0).toFixed(1)}٪)`;
  if (topVol) text += `\nبزرگ‌ترین جهش حجم: ${topVol.symbol} (${(topVol.changePct || 0).toFixed(0)}٪ بالاتر از معمول)`;
  if (!items.length) text += "\nدیشب و امروز هیچ هشداری ثبت نشد.";
  return text;
}
function checkDailySummary() {
  if (!state.dailySummaryEnabled) return;
  const now = Date.now();
  const hourStr = new Intl.DateTimeFormat("en-GB", { timeZone: TIMEZONE, hour: "2-digit", minute: "2-digit", hour12: false }).format(now);
  const [hh, mm] = hourStr.split(":").map(Number);
  const todayKey = tehranDateKey(now);
  if (hh === state.dailySummaryHour && mm === 0 && state.lastSummaryDate !== todayKey) {
    state.lastSummaryDate = todayKey;
    saveState();
    sendTelegram(buildDailySummaryText());
  }
}

// ---------------- منوی دکمه‌ای ----------------
function menuMain() {
  return {
    text: "📋 منوی پامپ‌یاب\nیه بخش رو انتخاب کن:",
    keyboard: [
      [{ text: (state.paused ? "▶️ ادامه‌ی رصد" : "⏸ توقف رصد"), callback_data: "toggle:paused:main" }, { text: "📊 وضعیت کامل", callback_data: "show:status" }],
      [{ text: "🎯 آستانه‌ها", callback_data: "menu:thresholds" }, { text: "⭐ واچ‌لیست / لیست سیاه", callback_data: "menu:lists" }],
      [{ text: "🔔 آلارم قیمت", callback_data: "menu:pricealerts" }, { text: "🔇 سکوت موقت", callback_data: "menu:mute" }],
      [{ text: "📋 گزارش و تاریخچه", callback_data: "menu:reports" }, { text: "⚙️ تنظیمات پیشرفته", callback_data: "menu:advanced" }],
      [{ text: "📖 دستورالعمل کامل دستورات", callback_data: "guide:main" }],
    ],
  };
}
function menuThresholds() {
  return {
    text: "🎯 آستانه‌ها\n\n" +
      `پامپ فعلی: ${state.threshold}٪\nافت فعلی: ${state.dumpThreshold}٪\n\n` +
      "برای تغییر، یکی از این‌ها رو تایپ و بفرست:\n/threshold 7\n/dumpthreshold 6",
    keyboard: [[{ text: "🔙 منو", callback_data: "menu:main" }]],
  };
}
function menuLists() {
  return {
    text: "⭐ لیست ویژه / لیست سیاه\n\n" +
      "برای افزودن به لیست ویژه، تایپ کن:\n/watch BTC — رصد کامل (پامپ/دامپ/حجم/شکست/مقاومت‌وحمایت)\n" +
      "/stoploss BTC 60000 — حد ضرر (خودکار اضافه می‌شه)\n" +
      "/takeprofit BTC 80000 — حد سود (خودکار اضافه می‌شه)\n" +
      "/levels BTC — نمایش مقاومت/حمایت\n\n" +
      "برای مسدودکردن کامل: /blacklist DOGE",
    keyboard: [
      [{ text: "⭐ نمایش لیست ویژه", callback_data: "show:watchlist" }, { text: "🚫 نمایش لیست سیاه", callback_data: "show:blacklistshow" }],
      [{ text: "🔙 منو", callback_data: "menu:main" }],
    ],
  };
}
function menuPriceAlerts() {
  return {
    text: "🔔 آلارم قیمت\n\n" +
      "برای ثبت، تایپ کن:\n/alert BTC 70000 75000\n(چندتا قیمت با فاصله؛ above/below هم قابل استفاده‌ست)",
    keyboard: [
      [{ text: "🔔 نمایش آلارم‌های فعال", callback_data: "show:alerts" }],
      [{ text: "🔙 منو", callback_data: "menu:main" }],
    ],
  };
}
function menuMute() {
  return {
    text: "🔇 سکوت موقت\n\n" +
      "برای سکوت یه کوین، تایپ کن:\n/mute DOGE 6h  (یا 30m، 1d)\nبرای لغو: /unmute DOGE",
    keyboard: [
      [{ text: "🔇 نمایش کوین‌های ساکت‌شده", callback_data: "show:mutes" }],
      [{ text: "🔙 منو", callback_data: "menu:main" }],
    ],
  };
}
function menuReports() {
  return {
    text: "📋 گزارش و تاریخچه\n\nبرای گزارش یه کوین خاص تایپ کن:\n/report BTC 7",
    keyboard: [
      [{ text: "🕘 آخرین هشدارها", callback_data: "show:history" }, { text: "🗓 خلاصه‌ی امروز", callback_data: "run:summarynow" }],
      [{ text: "📈 بک‌تست ۷ روز", callback_data: "run:backtest7" }, { text: "📄 خروجی CSV ۳۰ روز", callback_data: "run:export30" }],
      [{ text: "🔙 منو", callback_data: "menu:main" }],
    ],
  };
}
function menuAdvanced() {
  return {
    text: "⚙️ تنظیمات پیشرفته\n\n" +
      `آستانه‌ی پویا: ${state.dynamicEnabled ? "فعال ✅" : "غیرفعال ⏹"} (ضریب ${state.dynamicFactor})\n` +
      `هشدار جهش حجم: ${state.volumeAlertEnabled ? "فعال ✅" : "غیرفعال ⏹"} (×${state.volumeSpikeMultiplier})\n` +
      `خلاصه‌ی روزانه: ${state.dailySummaryEnabled ? "فعال ✅ (ساعت " + state.dailySummaryHour + ")" : "غیرفعال ⏹"}\n` +
      `ورود تازه به لیست برتر: ${state.newEntrantEnabled ? "فعال ✅" : "غیرفعال ⏹"}\n` +
      `شکست سقف/کف ۲۴ساعته: ${state.breakoutAlertEnabled ? "فعال ✅ (" + state.breakoutMinPercent + "٪)" : "غیرفعال ⏹"}\n` +
      `مقاومت/حمایت لیست ویژه: ${state.pivotAlertEnabled ? "فعال ✅" : "غیرفعال ⏹"}`,
    keyboard: [
      [{ text: state.dynamicEnabled ? "⏹ خاموش‌کردن آستانه‌ی پویا" : "✅ روشن‌کردن آستانه‌ی پویا", callback_data: "toggle:dynamicEnabled:advanced" }],
      [{ text: state.volumeAlertEnabled ? "⏹ خاموش‌کردن هشدار حجم" : "✅ روشن‌کردن هشدار حجم", callback_data: "toggle:volumeAlertEnabled:advanced" }],
      [{ text: state.dailySummaryEnabled ? "⏹ خاموش‌کردن خلاصه‌ی روزانه" : "✅ روشن‌کردن خلاصه‌ی روزانه", callback_data: "toggle:dailySummaryEnabled:advanced" }],
      [{ text: state.newEntrantEnabled ? "⏹ خاموش‌کردن ورود تازه" : "✅ روشن‌کردن ورود تازه", callback_data: "toggle:newEntrantEnabled:advanced" }],
      [{ text: state.breakoutAlertEnabled ? "⏹ خاموش‌کردن شکست سقف/کف" : "✅ روشن‌کردن شکست سقف/کف", callback_data: "toggle:breakoutAlertEnabled:advanced" }],
      [{ text: state.pivotAlertEnabled ? "⏹ خاموش‌کردن مقاومت/حمایت" : "✅ روشن‌کردن مقاومت/حمایت", callback_data: "toggle:pivotAlertEnabled:advanced" }],
      [{ text: "🔙 منو", callback_data: "menu:main" }],
    ],
  };
}
function getMenuSection(section) {
  if (section === "thresholds") return menuThresholds();
  if (section === "lists") return menuLists();
  if (section === "pricealerts") return menuPriceAlerts();
  if (section === "mute") return menuMute();
  if (section === "reports") return menuReports();
  if (section === "advanced") return menuAdvanced();
  return menuMain();
}
function getShowContent(key) {
  if (key === "status") return { text: statusText(), keyboard: null };
  if (key === "watchlist") return { text: state.watchlist.length ? "⭐ واچ‌لیست:\n" + state.watchlist.map((w) => w.symbol.toUpperCase()).join("، ") : "واچ‌لیست خالیه.", keyboard: null };
  if (key === "blacklistshow") return { text: "🚫 لیست سیاه:\n" + state.blacklist.join("، "), keyboard: null };
  if (key === "alerts") return buildAlertsView(null);
  if (key === "mutes") { cleanupMutes(Date.now()); return { text: state.mutes.length ? "🔇 کوین‌های ساکت‌شده:\n" + state.mutes.map((mm) => `${mm.symbol.toUpperCase()} تا ${fmtDateTime(mm.until)}`).join("\n") : "هیچ کوینی ساکت نیست.", keyboard: null }; }
  if (key === "history") return { text: historyText(), keyboard: null };
  return { text: "—", keyboard: null };
}


// ---------------- راهنمای کامل (دستورالعمل استفاده) ----------------
function sendGuide(text, keyboard) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const body = { chat_id: TELEGRAM_CHAT_ID, text: text, parse_mode: "HTML" };
  if (keyboard) body.reply_markup = { inline_keyboard: keyboard };
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch((err) => console.error("خطا در ارسال راهنما:", err.message));
}
function editGuide(chatId, messageId, text, keyboard) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`;
  const body = { chat_id: chatId, message_id: messageId, text: text, parse_mode: "HTML" };
  if (keyboard) body.reply_markup = { inline_keyboard: keyboard };
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch((err) => console.error("خطا در ویرایش راهنما:", err.message));
}

const CMD_GUIDE = {
  menu: { usage: "/menu", desc: "منوی دکمه‌ای همه‌ی بخش‌ها. برای کارهای روزمره (روشن/خاموش‌کردن یه تنظیم، دیدن لیست‌ها) سریع‌تر از تایپ‌کردنه.", example: null },
  help: { usage: "/help  یا  /help نام‌دستور", desc: "همین راهنماست. بدون آرگومان، منوی دسته‌بندی‌شده نشون می‌ده. با اسم یه دستور (بدون /)، توضیح کامل همون یکی رو می‌ده.", example: "/help threshold" },
  status: { usage: "/status", desc: "وضعیت فعلی ربات: آستانه‌ها، تعداد کوین‌های رصدشده، واچ‌لیست، لیست سیاه، آستانه‌ی پویا، هشدار حجم، و آخرین زمان بروزرسانی.", example: null },
  pause: { usage: "/pause", desc: "رصد پامپ/دامپ/جهش‌حجم رو موقت متوقف می‌کنه. آلارم‌های قیمتی و حد ضرر/سود که دستی گذاشتی، همچنان فعال می‌مونن.", example: null },
  resume: { usage: "/resume", desc: "رصد رو دوباره از سر می‌گیره.", example: null },

  threshold: { usage: "/threshold [عدد]", desc: "آستانه‌ی رشد قیمت (به درصد) که باعث هشدار «پامپ» می‌شه. اگه کوینی توی یکی از بازه‌های ۱، ۵ یا ۱۵ دقیقه به این درصد یا بیشتر برسه، بهت خبر داده می‌شه. تغییر فوری اعمال می‌شه.", example: "/threshold 7" },
  dumpthreshold: { usage: "/dumpthreshold [عدد]", desc: "همون آستانه‌ی بالا، ولی برای افت قیمت (دامپ). عدد رو مثبت وارد کن، خودش به‌صورت منفی ذخیره می‌شه.", example: "/dumpthreshold 6" },
  dynamic: { usage: "/dynamic on  یا  /dynamic off", desc: "آستانه‌ی پویا: به‌جای یه آستانه‌ی ثابت برای همه، نوسان معمول هر کوین رو در نظر می‌گیره. کوین‌های پرنوسان نیاز به حرکت بزرگ‌تری دارن تا هشدار بدن؛ آستانه‌ی دستی‌ات همیشه به‌عنوان کف باقی می‌مونه.", example: null },
  dynamicfactor: { usage: "/dynamicfactor [عدد]", desc: "ضریب آستانه‌ی پویا. هرچی بیشتر باشه، برای کوین‌های پرنوسان سخت‌گیرتر می‌شه. پیش‌فرض 0.4.", example: "/dynamicfactor 0.5" },
  marketwide: { usage: "/marketwide [عدد]", desc: "آستانه‌ی تشخیص «هم‌جهتی با کل بازار». وقتی پامپی شناسایی می‌شه، اگه بیت‌کوین هم هم‌زمان به این اندازه حرکت کرده باشه، توی پیام هشدار داده می‌شه که این حرکت شاید فقط دنبال‌کردن بازار باشه، نه پامپ مستقل.", example: "/marketwide 3" },

  volumealert: { usage: "/volumealert on  یا  /volumealert off", desc: "هشدار جهش حجم معاملات، مستقل از حرکت قیمت. وقتی حجم یه کوین ناگهان چند برابر معمولش بشه، خبر می‌ده — این می‌تونه قبل از خود پامپ اتفاق بیفته.", example: null },
  volumefactor: { usage: "/volumefactor [عدد]", desc: "چند برابر حجم معمول کوین، به‌عنوان «جهش» حساب بشه. پیش‌فرض 2.5 (یعنی ۲.۵ برابر).", example: "/volumefactor 3" },

  watch: { usage: "/watch [SYMBOL]", desc: "کوین رو به لیست ویژه اضافه می‌کنه. کوین‌های این لیست همیشه رصد می‌شن (حتی اگه حجمشون زیر حد تعیین‌شده باشه) و مقاومت/حمایتشون هم محاسبه می‌شه.", example: "/watch BTC" },
  unwatch: { usage: "/unwatch [SYMBOL]", desc: "کوین رو از لیست ویژه حذف می‌کنه.", example: "/unwatch BTC" },
  watchlist: { usage: "/watchlist", desc: "نمایش کامل لیست ویژه: قیمت فعلی، سطوح مقاومت/حمایت، و حد ضرر/سود فعال هر کوین.", example: null },
  blacklist: { usage: "/blacklist [SYMBOL]", desc: "این کوین کاملاً نادیده گرفته می‌شه، هیچ نوع هشداری براش نمیاد.", example: "/blacklist DOGE" },
  unblacklist: { usage: "/unblacklist [SYMBOL]", desc: "کوین رو از لیست سیاه حذف می‌کنه.", example: "/unblacklist DOGE" },
  blacklistshow: { usage: "/blacklistshow", desc: "نمایش همه‌ی کوین‌های مسدودشده.", example: null },

  mute: { usage: "/mute [SYMBOL] [مدت]", desc: "سکوت موقت یه کوین برای پامپ/دامپ/جهش‌حجم. واحد مدت: m برای دقیقه، h برای ساعت، d برای روز. آلارم قیمتی دستی که گذاشته باشی، همچنان فعال می‌مونه.", example: "/mute DOGE 6h" },
  unmute: { usage: "/unmute [SYMBOL]", desc: "سکوت رو زودتر از موعد لغو می‌کنه.", example: "/unmute DOGE" },
  mutes: { usage: "/mutes", desc: "نمایش کوین‌های ساکت‌شده و زمان پایان سکوتشون.", example: null },

  levels: { usage: "/levels [SYMBOL]", desc: "سطوح مقاومت (R1-R3) و حمایت (S1-S3) فعلیِ محاسبه‌شده برای یه کوین رو نشون می‌ده، بدون نیاز به صبر برای شکسته‌شدنشون. بر پایه‌ی فرمول Pivot Point، از روی ۲۴ ساعت اخیره.", example: "/levels BTC" },
  stoploss: { usage: "/stoploss [SYMBOL] [قیمت]", desc: "حد ضرر ثبت می‌کنه (باید پایین‌تر از قیمت فعلی باشه). کوین خودکار به لیست ویژه هم اضافه می‌شه. وقتی قیمت به این حد برسه، پیام 🛑 می‌گیری.", example: "/stoploss BTC 60000" },
  takeprofit: { usage: "/takeprofit [SYMBOL] [قیمت]", desc: "حد سود ثبت می‌کنه (باید بالاتر از قیمت فعلی باشه). کوین خودکار به لیست ویژه هم اضافه می‌شه. وقتی قیمت به این حد برسه، پیام 🎯 می‌گیری.", example: "/takeprofit BTC 80000" },
  pivot: { usage: "/pivot on  یا  /pivot off", desc: "روشن/خاموش‌کردن هشدار شکست مقاومت/حمایت برای کوین‌های لیست ویژه.", example: null },
  pivotbuffer: { usage: "/pivotbuffer [عدد]", desc: "یه منطقه‌ی امن دور هر سطح مقاومت/حمایت (به درصد) تا وقتی قیمت دقیقاً روی مرز نوسان می‌کنه، هشدار تکراری نیاد. پیش‌فرض 0.5٪.", example: "/pivotbuffer 0.5" },
  profile: { usage: "/profile [SYMBOL]", desc: "مشخصات کامل یه رمزارز: قیمت، روند ۱ساعته/۴ساعته/روزانه/هفتگی، سقف و کف ۲۴ساعته، مقاومت و حمایت، حد ضرر/سود فعال، حجم معاملات، و وضعیت نسبت به بیت‌کوین. همه‌چی یک‌جا.", example: "/profile BTC" },

  alert: { usage: "/alert [SYMBOL] [قیمت] [قیمت دوم ...]", desc: "آلارم قیمت ثبت می‌کنه؛ می‌تونی چندتا قیمت هم‌زمان بدی. جهت (بالاتر/پایین‌تر) خودکار نسبت به قیمت فعلی تشخیص داده می‌شه؛ برای اجباری‌کردن جهت یه قیمت خاص، کلمه‌ی above یا below رو درست قبلش بذار. هر آلارم یک‌بار مصرفه.", example: "/alert BTC 70000 75000 60000" },
  alerts: { usage: "/alerts  یا  /alerts [SYMBOL]", desc: "لیست آلارم‌های قیمت فعال رو نشون می‌ده، با دکمه‌ی ❌ زیر هرکدوم برای حذف سریع.", example: null },
  delalert: { usage: "/delalert [SYMBOL] [قیمت]", desc: "یه آلارم خاص رو حذف می‌کنه. بدون قیمت، همه‌ی آلارم‌های اون کوین پاک می‌شن.", example: "/delalert BTC 70000" },

  report: { usage: "/report [SYMBOL] [روز]", desc: "گزارش کامل یه کوین: تعداد پامپ/دامپ/آلارم قیمت، قیمت لحظه‌ی هر هشدار، و وضعیت الانش نسبت به اون‌موقع. پیش‌فرض ۳۰ روز اخیر.", example: "/report BTC 7" },
  history: { usage: "/history", desc: "آخرین ۱۰ هشداری که ربات فرستاده، با زمانشون.", example: null },
  backtest: { usage: "/backtest [روز]", desc: "عملکرد واقعیِ هشدارهایی که ربات توی این بازه فرستاده رو می‌سنجه: چند درصدشون تا الان هم‌جهت موندن. شبیه‌سازی کل بازار نیست، فقط آمار هشدارهای خودته.", example: "/backtest 7" },
  export: { usage: "/export [روز]", desc: "خروجی CSV از تاریخچه‌ی هشدارها، برای تحلیل توی اکسل یا گوگل‌شیت.", example: "/export 30" },
  dailysummary: { usage: "/dailysummary on  یا  /dailysummary off", desc: "یه پیام خلاصه هر روز (پیش‌فرض ساعت ۹ صبح ایران) با آمار ۲۴ ساعت اخیر.", example: null },
  summaryhour: { usage: "/summaryhour [۰ تا ۲۳]", desc: "ساعت ارسال خلاصه‌ی روزانه رو تغییر می‌ده (به وقت ایران).", example: "/summaryhour 9" },
  summarynow: { usage: "/summarynow", desc: "خلاصه‌ی روزانه رو همین الان می‌فرسته، بدون نیاز به صبر تا فردا (خوبه برای تست).", example: null },

  newentrant: { usage: "/newentrant on  یا  /newentrant off", desc: "هشدار وقتی یه کوین تازه وارد لیست ۲۵۰/۵۰۰ کوین برتر بازار می‌شه — معمولاً نشونه‌ی رشد یا لیستینگ مهمه.", example: null },
  breakout: { usage: "/breakout on  یا  /breakout off", desc: "هشدار وقتی قیمت یه کوین از سقف یا کف ۲۴ساعته‌ی قبلی‌ش رد می‌شه.", example: null },
  breakoutfactor: { usage: "/breakoutfactor [عدد]", desc: "حداقل درصد تغییر سقف/کف تا به‌عنوان «شکست» حساب بشه. پیش‌فرض 1.", example: "/breakoutfactor 1.5" },
};

const GUIDE_SECTIONS = {
  start: {
    title: "🚀 شروع سریع",
    body: "این ربات ۲۴ ساعته بازار رمزارز رو رصد می‌کنه و وقتی اتفاق مهمی بیفته (رشد ناگهانی، افت شدید، جهش حجم، شکست سطح مهم) بهت پیام می‌ده.\n\n" +
      "برای شروع:\n" +
      "1. /status رو بزن تا وضعیت فعلی رو ببینی\n" +
      "2. اگه چندتا کوین خاص برات مهمه، با /watch اضافه‌شون کن\n" +
      "3. اگه می‌خوای حد ضرر/سود بذاری، از /stoploss و /takeprofit استفاده کن\n" +
      "4. برای مرور همه‌چی بدون تایپ، /menu رو امتحان کن\n\n" +
      "برای توضیح کامل هر دستور، از دکمه‌های پایین برو توی هر بخش، یا بنویس «/help و اسم دستور» (مثلاً /help threshold).",
    cmds: [],
  },
  control: { title: "⚙️ کنترل و وضعیت", cmds: ["menu", "help", "status", "pause", "resume"] },
  thresholds: { title: "🎯 آستانه‌ها", cmds: ["threshold", "dumpthreshold", "dynamic", "dynamicfactor", "marketwide"] },
  volume: { title: "📢 حجم معاملات", cmds: ["volumealert", "volumefactor"] },
  lists: { title: "⭐ واچ‌لیست و لیست سیاه", cmds: ["watch", "unwatch", "watchlist", "blacklist", "unblacklist", "blacklistshow"] },
  mute: { title: "🔇 سکوت موقت", cmds: ["mute", "unmute", "mutes"] },
  vip: { title: "📊 لیست ویژه (مقاومت/حمایت/حد ضرر/سود)", cmds: ["levels", "stoploss", "takeprofit", "pivot", "pivotbuffer", "profile"] },
  pricealerts: { title: "🔔 آلارم قیمت", cmds: ["alert", "alerts", "delalert"] },
  reports: { title: "📋 گزارش و تاریخچه", cmds: ["report", "history", "backtest", "export", "dailysummary", "summaryhour", "summarynow"] },
  advanced: { title: "🧪 هشدارهای پیشرفته", cmds: ["newentrant", "breakout", "breakoutfactor"] },
};

function formatCmdGuide(name) {
  const g = CMD_GUIDE[name];
  if (!g) return "";
  let block = `<b>${g.usage}</b>\n${g.desc}`;
  if (g.example) block += `\nمثال: <code>${g.example}</code>`;
  return block;
}
function guideSectionView(key) {
  const sec = GUIDE_SECTIONS[key];
  if (!sec) return guideMainView();
  let text = `<b>${sec.title}</b>\n\n`;
  if (sec.body) text += sec.body;
  else text += sec.cmds.map(formatCmdGuide).join("\n\n");
  const keyboard = [[{ text: "🔙 فهرست راهنما", callback_data: "guide:main" }]];
  return { text, keyboard };
}
function guideMainView() {
  return {
    text: "📖 <b>دستورالعمل کامل پامپ‌یاب</b>\nیه بخش رو انتخاب کن تا توضیح کامل دستوراتش رو ببینی:",
    keyboard: [
      [{ text: "🚀 شروع سریع", callback_data: "guide:start" }],
      [{ text: "⚙️ کنترل و وضعیت", callback_data: "guide:control" }, { text: "🎯 آستانه‌ها", callback_data: "guide:thresholds" }],
      [{ text: "📢 حجم معاملات", callback_data: "guide:volume" }, { text: "⭐ واچ‌لیست/بلاک‌لیست", callback_data: "guide:lists" }],
      [{ text: "🔇 سکوت موقت", callback_data: "guide:mute" }, { text: "📊 لیست ویژه", callback_data: "guide:vip" }],
      [{ text: "🔔 آلارم قیمت", callback_data: "guide:pricealerts" }, { text: "📋 گزارش‌ها", callback_data: "guide:reports" }],
      [{ text: "🧪 هشدارهای پیشرفته", callback_data: "guide:advanced" }],
    ],
  };
}

// ---------------- دستورات و دکمه‌های تلگرام ----------------
let telegramOffset = 0;

function statusText() {
  return "📊 وضعیت پامپ‌یاب\n" +
    `حالت: ${state.paused ? "متوقف ⏸" : "فعال ▶️"}\n` +
    `آستانه‌ی پامپ: ${state.threshold}٪ | آستانه‌ی افت: ${state.dumpThreshold}٪\n` +
    `بازه‌ها: ${WINDOWS_MINUTES.join("، ")} دقیقه | حداقل حجم: $${fmtNum(MIN_VOLUME_USD)}\n` +
    `کوین‌های تحت رصد: ${history.size} | واچ‌لیست: ${state.watchlist.length} | لیست سیاه: ${state.blacklist.length} | آلارم قیمت: ${state.priceAlerts.length}\n` +
    `آستانه‌ی پویا: ${state.dynamicEnabled ? "فعال (ضریب " + state.dynamicFactor + ")" : "غیرفعال"} | هشدار حجم: ${state.volumeAlertEnabled ? "فعال (×" + state.volumeSpikeMultiplier + ")" : "غیرفعال"}\n` +
    `کوین‌های ساکت‌شده: ${state.mutes.length} | خلاصه‌ی روزانه: ${state.dailySummaryEnabled ? "ساعت " + state.dailySummaryHour + " (ایران)" : "غیرفعال"}\n` +
    `فیلتر بازار: آستانه ${state.marketWideThreshold}٪ | ورود تازه: ${state.newEntrantEnabled ? "فعال" : "غیرفعال"} | شکست ۲۴ساعته: ${state.breakoutAlertEnabled ? "فعال (" + state.breakoutMinPercent + "٪)" : "غیرفعال"}\n` +
    `مقاومت/حمایت لیست ویژه: ${state.pivotAlertEnabled ? "فعال" : "غیرفعال"}\n` +
    `آخرین بروزرسانی: ${lastPollAt ? fmtTimeOnly(lastPollAt) : "—"}`;
}
function historyText() {
  if (!state.history.length) return "هنوز هشداری ثبت نشده.";
  return "🕘 آخرین هشدارها:\n" + state.history.slice(0, 10).map((h) => {
    const time = fmtDateTime(h.t);
    const icon = h.type === "پامپ" ? PUMP_ICON1 : h.type === "دامپ" ? DUMP_ICON1 : h.type === "ورود" ? "🆕" : h.type === "شکست" ? ((h.changePct || 0) >= 0 ? PUMP_ICON1 : DUMP_ICON1) : h.type === "سطح" ? "📊" : h.type === "حدضرر" ? "🛑" : h.type === "حدسود" ? "🎯" : "🔔";
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

  if (cmd === "/alert") { await cmdAlert(parts); return; }
  if (cmd === "/alerts") { cmdAlerts(parts); return; }
  if (cmd === "/delalert") { cmdDelAlert(parts); return; }
  if (cmd === "/report") {
    if (!parts[1]) { sendTelegram("مثال: /report BTC   یا   /report BTC 7"); return; }
    const days = parseFloat(parts[2]) || 30;
    sendTelegram(await coinReport(parts[1], days));
    return;
  }
  if (cmd === "/menu") { const v = menuMain(); sendTelegram(v.text, v.keyboard); return; }
  if (cmd === "/status") { sendTelegram(statusText()); return; }
  if (cmd === "/help" || cmd === "/start") {
    const arg = (parts[1] || "").replace(/^\//, "").toLowerCase();
    if (arg && CMD_GUIDE[arg]) {
      sendGuide(formatCmdGuide(arg), [[{ text: "🔙 فهرست راهنما", callback_data: "guide:main" }]]);
    } else if (arg) {
      sendTelegram(`دستوری به اسم «${arg}» پیدا نشد. برای فهرست کامل، فقط /help رو بفرست.`);
    } else {
      const v = guideMainView();
      sendGuide(v.text, v.keyboard);
    }
    return;
  }
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
  if (cmd === "/pause") { state.paused = true; saveState(); sendTelegram("⏸ رصد پامپ/دامپ متوقف شد. آلارم‌های قیمت همچنان فعالن."); return; }
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
    if (!state.watchlist.length) { sendTelegram("لیست ویژه (واچ‌لیست) خالیه. با /watch یا /stoploss یا /takeprofit کوین اضافه کن."); return; }
    const lines = state.watchlist.map((w) => {
      const lv = pivotLevels.get(w.id);
      const arr = history.get(w.id);
      const price = arr && arr.length ? arr[arr.length - 1].p : null;
      let line = `⭐ ${w.symbol.toUpperCase()}` + (price != null ? ` — $${fmtPrice(price)}` : "");
      if (lv) line += `\n   مقاومت: R1 ${fmtPrice(lv.levels.R1)} · R2 ${fmtPrice(lv.levels.R2)} · R3 ${fmtPrice(lv.levels.R3)}` +
        `\n   حمایت: S1 ${fmtPrice(lv.levels.S1)} · S2 ${fmtPrice(lv.levels.S2)} · S3 ${fmtPrice(lv.levels.S3)}`;
      const sl = state.priceAlerts.find((a) => a.coinId === w.id && a.kind === "stoploss");
      const tp = state.priceAlerts.find((a) => a.coinId === w.id && a.kind === "takeprofit");
      if (sl) line += `\n   🛑 حد ضرر: $${fmtPrice(sl.target)}`;
      if (tp) line += `\n   🎯 حد سود: $${fmtPrice(tp.target)}`;
      return line;
    });
    sendTelegram("⭐ لیست ویژه:\n\n" + lines.join("\n\n"));
    return;
  }
  if (cmd === "/levels") {
    if (!parts[1]) { sendTelegram("مثال: /levels BTC"); return; }
    const found = await resolveSymbolToId(parts[1]);
    if (!found) { sendTelegram("کوینی با این نماد پیدا نشد."); return; }
    sendTelegram("در حال محاسبه‌ی سطوح...");
    const lv = await ensurePivotLevels(found.id);
    if (!lv) { sendTelegram("نتونستم سطوح رو محاسبه کنم؛ دوباره امتحان کن."); return; }
    sendTelegram(
      `📊 سطوح ${found.symbol.toUpperCase()} (بر پایه‌ی ۲۴ ساعت اخیر)\n\n` +
      `مقاومت سوم: $${fmtPrice(lv.R3)}\nمقاومت دوم: $${fmtPrice(lv.R2)}\nمقاومت اول: $${fmtPrice(lv.R1)}\n` +
      `نقطه‌ی پیوت: $${fmtPrice(lv.P)}\n` +
      `حمایت اول: $${fmtPrice(lv.S1)}\nحمایت دوم: $${fmtPrice(lv.S2)}\nحمایت سوم: $${fmtPrice(lv.S3)}`
    );
    return;
  }
  if (cmd === "/profile") { await cmdProfile(parts); return; }
  if (cmd === "/stoploss") { await cmdStopOrTake(parts, "stoploss"); return; }
  if (cmd === "/takeprofit") { await cmdStopOrTake(parts, "takeprofit"); return; }
  if (cmd === "/pivotbuffer") {
    const v = parseFloat(parts[1]);
    if (!isNaN(v) && v > 0) { state.pivotHysteresisPercent = v; saveState(); sendTelegram(`✅ منطقه‌ی امن مقاومت/حمایت روی ${v}٪ تنظیم شد.`); }
    else sendTelegram("عدد نامعتبر. مثال: /pivotbuffer 0.5");
    return;
  }
  if (cmd === "/pivot") {
    if (parts[1] === "on") { state.pivotAlertEnabled = true; saveState(); sendTelegram("✅ هشدار شکست مقاومت/حمایت فعال شد."); }
    else if (parts[1] === "off") { state.pivotAlertEnabled = false; saveState(); sendTelegram("⏹ هشدار شکست مقاومت/حمایت غیرفعال شد."); }
    else sendTelegram("مثال: /pivot on   یا   /pivot off");
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

  if (cmd === "/dynamic") {
    if (parts[1] === "on") { state.dynamicEnabled = true; saveState(); sendTelegram("✅ آستانه‌ی پویا فعال شد."); }
    else if (parts[1] === "off") { state.dynamicEnabled = false; saveState(); sendTelegram("⏹ آستانه‌ی پویا غیرفعال شد."); }
    else sendTelegram("مثال: /dynamic on   یا   /dynamic off");
    return;
  }
  if (cmd === "/dynamicfactor") {
    const v = parseFloat(parts[1]);
    if (!isNaN(v) && v > 0) { state.dynamicFactor = v; saveState(); sendTelegram(`✅ ضریب آستانه‌ی پویا روی ${v} تنظیم شد.`); }
    else sendTelegram("عدد نامعتبر. مثال: /dynamicfactor 0.5");
    return;
  }
  if (cmd === "/volumealert") {
    if (parts[1] === "on") { state.volumeAlertEnabled = true; saveState(); sendTelegram("✅ هشدار جهش حجم فعال شد."); }
    else if (parts[1] === "off") { state.volumeAlertEnabled = false; saveState(); sendTelegram("⏹ هشدار جهش حجم غیرفعال شد."); }
    else sendTelegram("مثال: /volumealert on   یا   /volumealert off");
    return;
  }
  if (cmd === "/volumefactor") {
    const v = parseFloat(parts[1]);
    if (!isNaN(v) && v > 1) { state.volumeSpikeMultiplier = v; saveState(); sendTelegram(`✅ ضریب جهش حجم روی ${v}× تنظیم شد.`); }
    else sendTelegram("عدد نامعتبر (باید بزرگ‌تر از ۱ باشه). مثال: /volumefactor 3");
    return;
  }

  if (cmd === "/mute") {
    if (!parts[1] || !parts[2]) { sendTelegram("مثال: /mute DOGE 6h   یا   /mute DOGE 30m   یا   /mute DOGE 1d"); return; }
    const ms = parseDuration(parts[2]);
    if (!ms) { sendTelegram("مدت نامعتبر. نمونه‌ها: 30m، 6h، 1d"); return; }
    const found = await resolveSymbolToId(parts[1]);
    if (!found) { sendTelegram("کوینی با این نماد پیدا نشد."); return; }
    state.mutes = state.mutes.filter((mm) => mm.id !== found.id);
    const until = Date.now() + ms;
    state.mutes.push({ id: found.id, symbol: found.symbol, until });
    saveState();
    sendTelegram(`🔇 ${found.symbol.toUpperCase()} تا ${fmtDateTime(until)} ساکت شد (پامپ/دامپ/حجم؛ آلارم قیمت دستی همچنان فعاله).`);
    return;
  }
  if (cmd === "/unmute") {
    if (!parts[1]) { sendTelegram("مثال: /unmute DOGE"); return; }
    const sym = parts[1].toUpperCase();
    const before = state.mutes.length;
    state.mutes = state.mutes.filter((mm) => mm.symbol.toUpperCase() !== sym);
    saveState();
    sendTelegram(state.mutes.length < before ? `${sym} از سکوت خارج شد.` : "این کوین ساکت نبود.");
    return;
  }
  if (cmd === "/mutes") {
    cleanupMutes(Date.now());
    sendTelegram(state.mutes.length
      ? "🔇 کوین‌های ساکت‌شده:\n" + state.mutes.map((mm) => `${mm.symbol.toUpperCase()} تا ${fmtDateTime(mm.until)}`).join("\n")
      : "هیچ کوینی ساکت نیست.");
    return;
  }

  if (cmd === "/export") {
    const days = parseFloat(parts[1]) || 30;
    sendTelegram("در حال آماده‌سازی فایل CSV...");
    await sendCsvExport(days);
    return;
  }

  if (cmd === "/dailysummary") {
    if (parts[1] === "on") { state.dailySummaryEnabled = true; saveState(); sendTelegram("✅ خلاصه‌ی روزانه فعال شد."); }
    else if (parts[1] === "off") { state.dailySummaryEnabled = false; saveState(); sendTelegram("⏹ خلاصه‌ی روزانه غیرفعال شد."); }
    else sendTelegram("مثال: /dailysummary on   یا   /dailysummary off");
    return;
  }
  if (cmd === "/summaryhour") {
    const v = parseInt(parts[1], 10);
    if (!isNaN(v) && v >= 0 && v <= 23) { state.dailySummaryHour = v; saveState(); sendTelegram(`✅ ساعت خلاصه‌ی روزانه روی ${v}:00 (ایران) تنظیم شد.`); }
    else sendTelegram("عدد نامعتبر (باید بین ۰ تا ۲۳ باشه). مثال: /summaryhour 9");
    return;
  }
  if (cmd === "/summarynow") { sendTelegram(buildDailySummaryText()); return; }

  if (cmd === "/marketwide") {
    const v = parseFloat(parts[1]);
    if (!isNaN(v) && v > 0) { state.marketWideThreshold = v; saveState(); sendTelegram(`✅ آستانه‌ی حرکت کل بازار روی ${v}٪ تنظیم شد.`); }
    else sendTelegram("عدد نامعتبر. مثال: /marketwide 3");
    return;
  }
  if (cmd === "/newentrant") {
    if (parts[1] === "on") { state.newEntrantEnabled = true; saveState(); sendTelegram("✅ هشدار ورود به لیست برتر فعال شد."); }
    else if (parts[1] === "off") { state.newEntrantEnabled = false; saveState(); sendTelegram("⏹ هشدار ورود به لیست برتر غیرفعال شد."); }
    else sendTelegram("مثال: /newentrant on   یا   /newentrant off");
    return;
  }
  if (cmd === "/breakout") {
    if (parts[1] === "on") { state.breakoutAlertEnabled = true; saveState(); sendTelegram("✅ هشدار شکست سقف/کف فعال شد."); }
    else if (parts[1] === "off") { state.breakoutAlertEnabled = false; saveState(); sendTelegram("⏹ هشدار شکست سقف/کف غیرفعال شد."); }
    else sendTelegram("مثال: /breakout on   یا   /breakout off");
    return;
  }
  if (cmd === "/breakoutfactor") {
    const v = parseFloat(parts[1]);
    if (!isNaN(v) && v > 0) { state.breakoutMinPercent = v; saveState(); sendTelegram(`✅ حداقل درصد شکست روی ${v}٪ تنظیم شد.`); }
    else sendTelegram("عدد نامعتبر. مثال: /breakoutfactor 1.5");
    return;
  }
}

async function handleCallback(cq) {
  const data = cq.data || "";
  const chatId = cq.message.chat.id;
  const msgId = cq.message.message_id;

  if (data.startsWith("delalert:")) {
    const uid = parseInt(data.slice("delalert:".length), 10);
    const before = state.priceAlerts.length;
    state.priceAlerts = state.priceAlerts.filter((a) => a.uid !== uid);
    saveState();
    answerCallback(cq.id, state.priceAlerts.length < before ? "آلارم حذف شد ✅" : "این آلارم قبلاً حذف شده");
    return;
  }
  if (data.startsWith("blacklist:")) {
    const id = data.slice("blacklist:".length);
    if (!state.blacklist.includes(id)) { state.blacklist.push(id); saveState(); }
    const m = meta.get(id);
    answerCallback(cq.id, (m ? m.symbol.toUpperCase() : id) + " مسدود شد ✅");
    return;
  }
  if (data.startsWith("menu:")) {
    const section = data.slice("menu:".length);
    const v = getMenuSection(section);
    answerCallback(cq.id, "");
    editMessage(chatId, msgId, v.text, v.keyboard);
    return;
  }
  if (data.startsWith("guide:")) {
    const section = data.slice("guide:".length);
    const v = section === "main" ? guideMainView() : guideSectionView(section);
    answerCallback(cq.id, "");
    editGuide(chatId, msgId, v.text, v.keyboard);
    return;
  }
  if (data.startsWith("show:")) {
    const key = data.slice("show:".length);
    const v = getShowContent(key);
    answerCallback(cq.id, "");
    editMessage(chatId, msgId, v.text, (v.keyboard || []).concat([[{ text: "🔙 منو", callback_data: "menu:main" }]]));
    return;
  }
  if (data.startsWith("toggle:")) {
    const [, field, backTo] = data.split(":");
    if (Object.prototype.hasOwnProperty.call(state, field) && typeof state[field] === "boolean") {
      state[field] = !state[field];
      saveState();
    }
    answerCallback(cq.id, "به‌روز شد ✅");
    const v = getMenuSection(backTo === "main" ? "main" : backTo);
    editMessage(chatId, msgId, v.text, v.keyboard);
    return;
  }
  if (data.startsWith("run:")) {
    const action = data.slice("run:".length);
    answerCallback(cq.id, "در حال اجرا...");
    if (action === "backtest7") { sendTelegram(await backtestReport(7)); return; }
    if (action === "export30") { await sendCsvExport(30); return; }
    if (action === "summarynow") { sendTelegram(buildDailySummaryText()); return; }
    return;
  }
  answerCallback(cq.id, "دستور ناشناخته");
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

// ---------------- دکمه‌ی منوی تلگرام ----------------
const BOT_COMMANDS = [
  { command: "menu", description: "منوی دکمه‌ای همه‌ی بخش‌ها" },
  { command: "status", description: "وضعیت فعلی ربات" },
  { command: "help", description: "راهنمای کامل دستورات" },
  { command: "threshold", description: "تغییر آستانه‌ی پامپ" },
  { command: "dumpthreshold", description: "تغییر آستانه‌ی افت" },
  { command: "pause", description: "توقف موقت رصد پامپ/دامپ" },
  { command: "resume", description: "از سرگیری رصد" },
  { command: "watch", description: "افزودن کوین به واچ‌لیست" },
  { command: "unwatch", description: "حذف از واچ‌لیست" },
  { command: "watchlist", description: "نمایش واچ‌لیست" },
  { command: "blacklist", description: "مسدودکردن یه کوین" },
  { command: "unblacklist", description: "حذف از لیست سیاه" },
  { command: "blacklistshow", description: "نمایش لیست سیاه" },
  { command: "alert", description: "ثبت آلارم قیمت" },
  { command: "alerts", description: "نمایش آلارم‌های قیمت" },
  { command: "delalert", description: "حذف آلارم قیمت" },
  { command: "report", description: "گزارش یه کوین خاص" },
  { command: "history", description: "آخرین هشدارها" },
  { command: "backtest", description: "بک‌تست هشدارهای گذشته" },
  { command: "dynamic", description: "روشن/خاموش‌کردن آستانه‌ی پویا" },
  { command: "dynamicfactor", description: "ضریب آستانه‌ی پویا" },
  { command: "volumealert", description: "روشن/خاموش‌کردن هشدار حجم" },
  { command: "volumefactor", description: "ضریب جهش حجم" },
  { command: "mute", description: "سکوت موقت یه کوین" },
  { command: "unmute", description: "لغو سکوت" },
  { command: "mutes", description: "نمایش کوین‌های ساکت‌شده" },
  { command: "export", description: "خروجی CSV از تاریخچه" },
  { command: "dailysummary", description: "روشن/خاموش‌کردن خلاصه‌ی روزانه" },
  { command: "summaryhour", description: "ساعت ارسال خلاصه‌ی روزانه" },
  { command: "summarynow", description: "ارسال فوری خلاصه‌ی روزانه" },
  { command: "marketwide", description: "آستانه‌ی هم‌جهتی با کل بازار" },
  { command: "newentrant", description: "روشن/خاموش ورود به لیست برتر" },
  { command: "breakout", description: "روشن/خاموش شکست سقف/کف" },
  { command: "breakoutfactor", description: "حداقل درصد شکست سقف/کف" },
  { command: "levels", description: "نمایش مقاومت/حمایت یه کوین" },
  { command: "stoploss", description: "ثبت حد ضرر" },
  { command: "takeprofit", description: "ثبت حد سود" },
  { command: "pivot", description: "روشن/خاموش شکست مقاومت/حمایت" },
  { command: "pivotbuffer", description: "منطقه‌ی امن دور سطوح مقاومت/حمایت" },
  { command: "profile", description: "مشخصات کامل یه رمزارز" },
];
async function registerBotUI() {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setMyCommands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commands: BOT_COMMANDS }),
    });
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setChatMenuButton`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, menu_button: { type: "commands" } }),
    });
  } catch (e) {
    console.error("خطا در ثبت دکمه‌ی منوی تلگرام:", e.message);
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
  registerBotUI();
  pollOnce();
  setInterval(pollOnce, POLL_SECONDS * 1000);
  setInterval(pollTelegramCommands, 4000);
  setInterval(checkDailySummary, 60000);
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
