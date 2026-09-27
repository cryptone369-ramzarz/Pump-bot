/**
 * پامپ‌یاب حرفه‌ای — رصد رشد/افت کوتاه‌مدت قیمت رمزارزها (از CoinGecko)
 * و اطلاع‌رسانی از طریق ربات تلگرام، با فیلتر نقدینگی، چند بازه‌ی زمانی
 * هم‌زمان، و کنترل زنده از طریق دستورات تلگرام.
 */

// ---------------- تنظیمات پایه (از متغیرهای محیطی) ----------------
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const HYSTERESIS_PERCENT = parseFloat(process.env.HYSTERESIS_PERCENT || "1.5");
const POLL_SECONDS       = parseFloat(process.env.POLL_SECONDS || "40");
const PAGES              = parseInt(process.env.PAGES || "1", 10);
const COINGECKO_API_KEY  = process.env.COINGECKO_API_KEY || "";
const MIN_VOLUME_USD     = parseFloat(process.env.MIN_VOLUME_USD || "5000000");
const WINDOWS_MINUTES = (process.env.WINDOWS_MINUTES || "1,5,15")
  .split(",").map((s) => parseFloat(s.trim())).filter((n) => !isNaN(n) && n > 0);
const MAX_WINDOW_MINUTES = Math.max.apply(null, WINDOWS_MINUTES);

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error("خطا: TELEGRAM_BOT_TOKEN و TELEGRAM_CHAT_ID رو به‌عنوان متغیر محیطی تنظیم کن (راهنما در README.md).");
  process.exit(1);
}

// این‌ها در حین اجرا هم از طریق دستورات تلگرام قابل تغییرن، پس let هستن
let THRESHOLD_PERCENT      = parseFloat(process.env.THRESHOLD_PERCENT || "5");
let DUMP_THRESHOLD_PERCENT = -Math.abs(parseFloat(process.env.DUMP_THRESHOLD_PERCENT || "5"));
let PAUSED = false;

const WINDOW_MS = MAX_WINDOW_MINUTES * 60 * 1000;
const BUFFER_MS = WINDOW_MS + POLL_SECONDS * 1000 * 2;

const history = new Map();       // id -> [{t,p}, ...]
const meta = new Map();          // id -> {name, symbol, volume, rank}
const notifiedPump = new Map();  // id -> bool
const notifiedDump = new Map();  // id -> bool

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

function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: text }),
  }).catch((err) => console.error("خطا در ارسال پیام تلگرام:", err.message));
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

function pushPrice(id, price, now) {
  let arr = history.get(id);
  if (!arr) { arr = []; history.set(id, arr); }
  arr.push({ t: now, p: price });
  while (arr.length && now - arr[0].t > BUFFER_MS) arr.shift();
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

// ---------------- ارزیابی و اطلاع‌رسانی ----------------
function evaluate(now) {
  for (const [id, arr] of history.entries()) {
    if (arr.length < 2) continue;
    const m = meta.get(id);
    if (!m) continue;
    if (m.volume < MIN_VOLUME_USD) continue; // فیلتر نقدینگی

    const changes = computeChanges(arr, now);
    const vals = Object.values(changes).filter((v) => v != null);
    if (!vals.length) continue;
    const maxChange = Math.max.apply(null, vals);
    const minChange = Math.min.apply(null, vals);
    const latestPrice = arr[arr.length - 1].p;

    // --- پامپ ---
    const pumpWindows = WINDOWS_MINUTES.filter((w) => changes[w] != null && changes[w] >= THRESHOLD_PERCENT);
    const wasPump = notifiedPump.get(id) || false;
    if (pumpWindows.length) {
      if (!wasPump) {
        notifiedPump.set(id, true);
        const lines = pumpWindows.map((w) => `${w} دقیقه: +${changes[w].toFixed(1)}٪`).join("\n");
        sendTelegram(
          `🚀 پامپ شناسایی شد: ${m.symbol.toUpperCase()} (${m.name})\n${lines}\n` +
          `قیمت فعلی: $${latestPrice}\n` +
          `حجم ۲۴ ساعته: $${fmtNum(m.volume)}\n` +
          `رتبه‌ی بازار: #${m.rank || "—"}`
        );
        console.log(`[PUMP] ${m.symbol.toUpperCase()} +${maxChange.toFixed(2)}%`);
      }
    } else if (maxChange < THRESHOLD_PERCENT - HYSTERESIS_PERCENT) {
      notifiedPump.set(id, false);
    }

    // --- دامپ (افت شدید) ---
    const dumpWindows = WINDOWS_MINUTES.filter((w) => changes[w] != null && changes[w] <= DUMP_THRESHOLD_PERCENT);
    const wasDump = notifiedDump.get(id) || false;
    if (dumpWindows.length) {
      if (!wasDump) {
        notifiedDump.set(id, true);
        const lines = dumpWindows.map((w) => `${w} دقیقه: ${changes[w].toFixed(1)}٪`).join("\n");
        sendTelegram(
          `🔻 افت شدید: ${m.symbol.toUpperCase()} (${m.name})\n${lines}\n` +
          `قیمت فعلی: $${latestPrice}\n` +
          `حجم ۲۴ ساعته: $${fmtNum(m.volume)}\n` +
          `رتبه‌ی بازار: #${m.rank || "—"}`
        );
        console.log(`[DUMP] ${m.symbol.toUpperCase()} ${minChange.toFixed(2)}%`);
      }
    } else if (minChange > DUMP_THRESHOLD_PERCENT + HYSTERESIS_PERCENT) {
      notifiedDump.set(id, false);
    }
  }
}

// ---------------- حلقه‌ی اصلی رصد بازار ----------------
async function pollOnce() {
  if (PAUSED) return;
  const now = Date.now();
  try {
    for (let p = 1; p <= PAGES; p++) {
      const coins = await fetchMarketsPage(p);
      for (const c of coins) {
        if (!c.current_price) continue;
        meta.set(c.id, { name: c.name, symbol: c.symbol, volume: c.total_volume || 0, rank: c.market_cap_rank });
        pushPrice(c.id, c.current_price, now);
      }
      if (p < PAGES) await sleep(2000);
    }
    evaluate(now);
    lastPollAt = now;
    if (consecutiveErrors > 0 || downAlertSent) {
      if (downAlertSent) sendTelegram("✅ اتصال به بازار دوباره برقرار شد.");
      console.log("اتصال به CoinGecko دوباره برقرار شد.");
    }
    consecutiveErrors = 0;
    downAlertSent = false;
  } catch (err) {
    consecutiveErrors++;
    if (err.message === "rate_limited_429") {
      console.error(`محدودیت نرخ CoinGecko (429) — تلاش شماره ${consecutiveErrors}.`);
    } else {
      console.error("خطا در دریافت اطلاعات بازار:", err.message);
    }
    if (consecutiveErrors >= 5 && !downAlertSent) {
      downAlertSent = true;
      sendTelegram("⚠️ چند بار پیاپی نتونستم اطلاعات بازار رو بگیرم؛ احتمال مشکل در اتصال یا محدودیت API هست.");
    }
  }
}

// ---------------- دستورات تلگرام (کنترل زنده) ----------------
let telegramOffset = 0;

function helpText() {
  return "دستورات قابل استفاده:\n" +
    "/status — وضعیت فعلی\n" +
    "/threshold <عدد> — تغییر آستانه‌ی پامپ (٪)\n" +
    "/dumpthreshold <عدد> — تغییر آستانه‌ی افت (٪)\n" +
    "/pause — توقف موقت رصد\n" +
    "/resume — از سرگیری رصد\n" +
    "/help — همین راهنما";
}

function statusText() {
  return "📊 وضعیت پامپ‌یاب\n" +
    `حالت: ${PAUSED ? "متوقف ⏸" : "فعال ▶️"}\n` +
    `آستانه‌ی پامپ: ${THRESHOLD_PERCENT}٪\n` +
    `آستانه‌ی افت: ${DUMP_THRESHOLD_PERCENT}٪\n` +
    `بازه‌های زمانی: ${WINDOWS_MINUTES.join("، ")} دقیقه\n` +
    `حداقل حجم معاملاتی: $${fmtNum(MIN_VOLUME_USD)}\n` +
    `کوین‌های تحت رصد: ${history.size}\n` +
    `آخرین بروزرسانی: ${lastPollAt ? new Date(lastPollAt).toLocaleTimeString("fa-IR") : "—"}`;
}

function handleCommand(text) {
  const parts = text.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();
  if (cmd === "/status") {
    sendTelegram(statusText());
  } else if (cmd === "/threshold") {
    const v = parseFloat(parts[1]);
    if (!isNaN(v) && v > 0) { THRESHOLD_PERCENT = v; sendTelegram(`✅ آستانه‌ی پامپ روی ${v}٪ تنظیم شد.`); }
    else sendTelegram("عدد نامعتبر. مثال: /threshold 7");
  } else if (cmd === "/dumpthreshold") {
    const v = parseFloat(parts[1]);
    if (!isNaN(v) && v > 0) { DUMP_THRESHOLD_PERCENT = -v; sendTelegram(`✅ آستانه‌ی افت روی ${-v}٪ تنظیم شد.`); }
    else sendTelegram("عدد نامعتبر. مثال: /dumpthreshold 6");
  } else if (cmd === "/pause") {
    PAUSED = true; sendTelegram("⏸ رصد بازار متوقف شد.");
  } else if (cmd === "/resume") {
    PAUSED = false; sendTelegram("▶️ رصد بازار از سر گرفته شد.");
  } else if (cmd === "/help" || cmd === "/start") {
    sendTelegram(helpText());
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
      const msg = upd.message;
      if (!msg || !msg.text) continue;
      if (String(msg.chat.id) !== String(TELEGRAM_CHAT_ID)) continue; // فقط چت خود کاربر
      handleCommand(msg.text);
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
    `✅ پامپ‌یاب فعال شد.\nآستانه‌ی پامپ: ${THRESHOLD_PERCENT}٪ | آستانه‌ی افت: ${DUMP_THRESHOLD_PERCENT}٪\n` +
    `بازه‌ها: ${WINDOWS_MINUTES.join("، ")} دقیقه | حداقل حجم: $${fmtNum(MIN_VOLUME_USD)}\n` +
    `برای دیدن دستورات: /help`
  );
  pollOnce();
  setInterval(pollOnce, POLL_SECONDS * 1000);
  setInterval(pollTelegramCommands, 4000);
}

start();

// سرور وضعیت ساده (برای Railway/Render و مانیتورینگ بیرونی مثل UptimeRobot)
const http = require("http");
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(
    "پامپ‌یاب در حال اجراست.\n" +
    "حالت: " + (PAUSED ? "متوقف" : "فعال") + "\n" +
    "کوین‌های تحت رصد: " + history.size + "\n" +
    "آخرین بروزرسانی: " + (lastPollAt ? new Date(lastPollAt).toISOString() : "—")
  );
}).listen(PORT, () => console.log("سرور وضعیت روی پورت " + PORT + " بالا اومد."));
