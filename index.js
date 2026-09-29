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
const notifiedVolume = new Map();
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
    const changes = computeChanges(arr, now);
    const vals = Object.values(changes).filter((v) => v != null);
    if (!vals.length) continue;
    const maxChange = Math.max.apply(null, vals);
    const minChange = Math.min.apply(null, vals);
    const latestPrice = arr[arr.length - 1].p;

    const pumpWindows = WINDOWS_MINUTES.filter((w) => changes[w] != null && changes[w] >= eff.pump);
    const wasPump = notifiedPump.get(id) || false;
    if (pumpWindows.length) {
      if (!wasPump) {
        notifiedPump.set(id, true);
        const trend = await trendConfirmation(id, "up");
        const conf = confidenceScore(m, maxChange, trend);
        const lines = pumpWindows.map((w) => `${PUMP_ICON} ${w} دقیقه: +${changes[w].toFixed(1)}٪`).join("\n");
        const label = `${m.symbol.toUpperCase()} +${maxChange.toFixed(1)}٪`;
        sendTelegram(
          `${PUMP_ICON} پامپ شناسایی شد: ${m.symbol.toUpperCase()} (${m.name})${isWatched ? " ⭐" : ""}\n${lines}\n` +
          `قیمت فعلی: $${fmtPrice(latestPrice)}\n` +
          `حجم ۲۴ ساعته: $${fmtNum(m.volume)} | رتبه: #${m.rank || "—"}\n` +
          `${conf.trendLine}\n` +
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
        const conf = confidenceScore(m, Math.abs(minChange), trend);
        const lines = dumpWindows.map((w) => `${DUMP_ICON} ${w} دقیقه: ${changes[w].toFixed(1)}٪`).join("\n");
        const label = `${m.symbol.toUpperCase()} ${minChange.toFixed(1)}٪`;
        sendTelegram(
          `${DUMP_ICON} افت شدید: ${m.symbol.toUpperCase()} (${m.name})${isWatched ? " ⭐" : ""}\n${lines}\n` +
          `قیمت فعلی: $${fmtPrice(latestPrice)}\n` +
          `حجم ۲۴ ساعته: $${fmtNum(m.volume)} | رتبه: #${m.rank || "—"}\n` +
          `${conf.trendLine}\n` +
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
    if (!state.paused) {
      for (let p = 1; p <= PAGES; p++) {
        const coins = await fetchMarketsPage(p);
        for (const c of coins) {
          if (!c.current_price) continue;
          meta.set(c.id, { name: c.name, symbol: c.symbol, volume: c.total_volume || 0, rank: c.market_cap_rank, marketCap: c.market_cap || 0 });
          pushPrice(c.id, c.current_price, now);
          updateBaselines(c, now);
          seen.add(c.id);
        }
        if (p < PAGES) await sleep(2000);
      }
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
        meta.set(c.id, { name: c.name, symbol: c.symbol, volume: c.total_volume || 0, rank: c.market_cap_rank, marketCap: c.market_cap || 0 });
        pushPrice(c.id, c.current_price, now);
        updateBaselines(c, now);
        seen.add(c.id);
      }
    }
    cleanupMutes(now);
    if (!state.paused) await evaluate(now);
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
    sendTelegram(
      `🔔 آلارم قیمت: ${a.symbol.toUpperCase()} (${a.name})\n` +
      `${arrow} $${fmtPrice(a.target)} رسید\n` +
      `قیمت فعلی: $${fmtPrice(price)}\n` +
      `آلارم‌های باقی‌مانده‌ی ${a.symbol.toUpperCase()}: ${left}`,
      [[{ text: "📈 نمودار", url: chartLink(a.coinId) }]]
    );
    pushHistoryLog("قیمت", a.symbol.toUpperCase(), a.name, `${a.symbol.toUpperCase()} ${a.dir === "above" ? PUMP_ICON1 : DUMP_ICON1} ${fmtPrice(a.target)}`, a.coinId, price);
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

function cmdAlerts(parts) {
  let list = state.priceAlerts;
  let title = "🔔 آلارم‌های قیمت";
  if (parts[1]) {
    const sym = parts[1].toUpperCase();
    list = list.filter((a) => a.symbol.toUpperCase() === sym);
    title += " " + sym;
  }
  if (!list.length) { sendTelegram("آلارم قیمتی ثبت نشده. برای ثبت: /alert BTC 70000"); return; }
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
  sendTelegram(`${title}:\n${lines.join("\n")}\n\nبرای حذف، روی دکمه‌ی هر آلارم بزن.`, keyboard);
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
    const icon = h.type === "پامپ" ? PUMP_ICON1 : h.type === "دامپ" ? DUMP_ICON1 : "🔔";
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
  let text = "🗓 خلاصه‌ی ۲۴ ساعت اخیر\n\n";
  text += `${PUMP_ICON1} پامپ: ${pumps.length} | ${DUMP_ICON1} دامپ: ${dumps.length} | 📢 جهش حجم: ${vols.length} | 🔔 آلارم قیمت: ${priceHits.length}\n`;
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

// ---------------- دستورات و دکمه‌های تلگرام ----------------
let telegramOffset = 0;

function helpText() {
  return "دستورات قابل استفاده:\n" +
    "/status — وضعیت فعلی\n" +
    "/threshold <عدد> — تغییر آستانه‌ی پامپ (٪)\n" +
    "/dumpthreshold <عدد> — تغییر آستانه‌ی افت (٪)\n" +
    "/pause — توقف موقت رصد پامپ/دامپ (آلارم‌های قیمت فعال می‌مونن)\n" +
    "/resume — از سرگیری رصد\n" +
    "/watch <SYMBOL> — اضافه‌کردن به واچ‌لیست\n" +
    "/unwatch <SYMBOL> — حذف از واچ‌لیست\n" +
    "/watchlist — نمایش واچ‌لیست\n" +
    "/blacklist <SYMBOL> — نادیده‌گرفتن یه کوین\n" +
    "/unblacklist <SYMBOL> — حذف از لیست سیاه\n" +
    "/blacklistshow — نمایش لیست سیاه\n" +
    "/history — آخرین هشدارها\n" +
    "/backtest <روز> — عملکرد واقعی هشدارهای گذشته (پیش‌فرض ۷ روز)\n" +
    "/alert <SYMBOL> <قیمت> [قیمت دوم ...] — ثبت آلارم قیمت (چندتا هم‌زمان)\n" +
    "/alerts [SYMBOL] — لیست آلارم‌های قیمت (با دکمه‌ی حذف)\n" +
    "/delalert <SYMBOL> [قیمت] — حذف آلارم (بدون قیمت = همه‌ی آلارم‌های اون کوین)\n" +
    "/report <SYMBOL> [روز] — گزارش هشدارهای یک کوین (پیش‌فرض ۳۰ روز)\n" +
    "/dynamic on|off — فعال/غیرفعال‌کردن آستانه‌ی پویا (بر اساس نوسان معمول هر کوین)\n" +
    "/dynamicfactor <عدد> — ضریب آستانه‌ی پویا (پیش‌فرض 0.4)\n" +
    "/volumealert on|off — فعال/غیرفعال‌کردن هشدار جهش حجم معاملات\n" +
    "/volumefactor <عدد> — چند برابر حجم معمول، جهش حساب بشه (پیش‌فرض 2.5)\n" +
    "/mute <SYMBOL> <مدت> — سکوت موقت یه کوین، مثلاً /mute DOGE 6h یا /mute DOGE 30m\n" +
    "/unmute <SYMBOL> — لغو سکوت\n" +
    "/mutes — نمایش کوین‌های ساکت‌شده\n" +
    "/export [روز] — خروجی CSV از تاریخچه (پیش‌فرض ۳۰ روز)\n" +
    "/dailysummary on|off — فعال/غیرفعال‌کردن خلاصه‌ی روزانه\n" +
    "/summaryhour <۰ تا ۲۳> — ساعت ارسال خلاصه‌ی روزانه (به وقت ایران)\n" +
    "/summarynow — ارسال فوری خلاصه (برای تست)\n" +
    "/help — همین راهنما";
}
function statusText() {
  return "📊 وضعیت پامپ‌یاب\n" +
    `حالت: ${state.paused ? "متوقف ⏸" : "فعال ▶️"}\n` +
    `آستانه‌ی پامپ: ${state.threshold}٪ | آستانه‌ی افت: ${state.dumpThreshold}٪\n` +
    `بازه‌ها: ${WINDOWS_MINUTES.join("، ")} دقیقه | حداقل حجم: $${fmtNum(MIN_VOLUME_USD)}\n` +
    `کوین‌های تحت رصد: ${history.size} | واچ‌لیست: ${state.watchlist.length} | لیست سیاه: ${state.blacklist.length} | آلارم قیمت: ${state.priceAlerts.length}\n` +
    `آستانه‌ی پویا: ${state.dynamicEnabled ? "فعال (ضریب " + state.dynamicFactor + ")" : "غیرفعال"} | هشدار حجم: ${state.volumeAlertEnabled ? "فعال (×" + state.volumeSpikeMultiplier + ")" : "غیرفعال"}\n` +
    `کوین‌های ساکت‌شده: ${state.mutes.length} | خلاصه‌ی روزانه: ${state.dailySummaryEnabled ? "ساعت " + state.dailySummaryHour + " (ایران)" : "غیرفعال"}\n` +
    `آخرین بروزرسانی: ${lastPollAt ? fmtTimeOnly(lastPollAt) : "—"}`;
}
function historyText() {
  if (!state.history.length) return "هنوز هشداری ثبت نشده.";
  return "🕘 آخرین هشدارها:\n" + state.history.slice(0, 10).map((h) => {
    const time = fmtDateTime(h.t);
    const icon = h.type === "پامپ" ? PUMP_ICON1 : h.type === "دامپ" ? DUMP_ICON1 : "🔔";
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
}

async function handleCallback(cq) {
  const data = cq.data || "";
  if (data.startsWith("delalert:")) {
    const uid = parseInt(data.slice("delalert:".length), 10);
    const before = state.priceAlerts.length;
    state.priceAlerts = state.priceAlerts.filter((a) => a.uid !== uid);
    saveState();
    answerCallback(cq.id, state.priceAlerts.length < before ? "آلارم حذف شد ✅" : "این آلارم قبلاً حذف شده");
  } else if (data.startsWith("blacklist:")) {
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
