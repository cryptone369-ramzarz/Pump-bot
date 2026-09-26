/**
 * پامپ‌یاب لحظه‌ای — رصد رشد کوتاه‌مدت قیمت رمزارزها (از CoinGecko)
 * و اطلاع‌رسانی از طریق ربات تلگرام (حتی وقتی اپ/مرورگر بسته باشه).
 */

// ---------------- تنظیمات (از متغیرهای محیطی) ----------------
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const THRESHOLD_PERCENT  = parseFloat(process.env.THRESHOLD_PERCENT || "5");
const WINDOW_MINUTES     = parseFloat(process.env.WINDOW_MINUTES || "5");
const HYSTERESIS_PERCENT = parseFloat(process.env.HYSTERESIS_PERCENT || "1.5");
const POLL_SECONDS       = parseFloat(process.env.POLL_SECONDS || "40");
const PAGES              = parseInt(process.env.PAGES || "1", 10);
const COINGECKO_API_KEY  = process.env.COINGECKO_API_KEY || "";

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error("خطا: TELEGRAM_BOT_TOKEN و TELEGRAM_CHAT_ID رو به‌عنوان متغیر محیطی تنظیم کن (راهنما در README.md).");
  process.exit(1);
}

const WINDOW_MS = WINDOW_MINUTES * 60 * 1000;
const BUFFER_MS = WINDOW_MS + POLL_SECONDS * 1000 * 2;

const history = new Map();
const notified = new Map();
const meta = new Map();

function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: text }),
  }).catch((err) => console.error("خطا در ارسال پیام تلگرام:", err.message));
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

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
  if (!arr) {
    arr = [];
    history.set(id, arr);
  }
  arr.push({ t: now, p: price });
  while (arr.length && now - arr[0].t > BUFFER_MS) arr.shift();
}

function evaluate(now) {
  for (const [id, arr] of history.entries()) {
    if (arr.length < 2) continue;
    let base = arr[0];
    for (let i = 0; i < arr.length; i++) {
      if (now - arr[i].t <= WINDOW_MS) { base = arr[i]; break; }
      base = arr[i];
    }
    const latest = arr[arr.length - 1];
    if (!base || base.p <= 0) continue;
    const changePct = ((latest.p - base.p) / base.p) * 100;

    const wasNotified = notified.get(id) || false;
    if (changePct >= THRESHOLD_PERCENT) {
      if (!wasNotified) {
        notified.set(id, true);
        const m = meta.get(id) || { name: id, symbol: id };
        sendTelegram(
          `🚀 پامپ شناسایی شد: ${m.symbol.toUpperCase()} (${m.name})\n` +
          `رشد ${changePct.toFixed(1)}٪ در ${WINDOW_MINUTES} دقیقه‌ی اخیر\n` +
          `قیمت فعلی: $${latest.p}`
        );
        console.log(`[ALERT] ${m.symbol.toUpperCase()} +${changePct.toFixed(2)}%`);
      }
    } else if (changePct < THRESHOLD_PERCENT - HYSTERESIS_PERCENT) {
      notified.set(id, false);
    }
  }
}

let consecutiveRateLimits = 0;

async function pollOnce() {
  const now = Date.now();
  try {
    for (let p = 1; p <= PAGES; p++) {
      const coins = await fetchMarketsPage(p);
      for (const c of coins) {
        if (!c.current_price) continue;
        meta.set(c.id, { name: c.name, symbol: c.symbol });
        pushPrice(c.id, c.current_price, now);
      }
      if (p < PAGES) await sleep(2000); // فاصله بین صفحات برای کاهش فشار
    }
    evaluate(now);
    if (consecutiveRateLimits > 0) {
      console.log("اتصال به CoinGecko دوباره برقرار شد.");
    }
    consecutiveRateLimits = 0;
  } catch (err) {
    if (err.message === "rate_limited_429") {
      consecutiveRateLimits++;
      console.error(`محدودیت نرخ CoinGecko (429) — تلاش شماره ${consecutiveRateLimits}. کمی صبر می‌کنیم...`);
    } else {
      console.error("خطا در دریافت اطلاعات بازار:", err.message);
    }
  }
}

let started = false;
function startPolling() {
  if (started) return;
  started = true;
  console.log("شروع رصد بازار از CoinGecko..." + (COINGECKO_API_KEY ? " (با کلید API)" : " (بدون کلید API)"));
  sendTelegram(`✅ پامپ‌یاب فعال شد. آستانه: ${THRESHOLD_PERCENT}٪ در ${WINDOW_MINUTES} دقیقه.`);
  pollOnce();
  setInterval(pollOnce, POLL_SECONDS * 1000);
}

startPolling();

const http = require("http");
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("پامپ‌یاب در حال اجراست.\nکوین‌های تحت رصد: " + history.size);
}).listen(PORT, () => console.log("سرور وضعیت روی پورت " + PORT + " بالا اومد."));
