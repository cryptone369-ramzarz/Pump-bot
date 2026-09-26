/**
 * پامپ‌یاب لحظه‌ای — رصد رشد کوتاه‌مدت قیمت رمزارزها از بایننس
 * و اطلاع‌رسانی از طریق ربات تلگرام (حتی وقتی اپ/مرورگر بسته باشه).
 *
 * این اسکریپت باید روی یه سرور همیشه‌روشن اجرا بشه (نه روی گوشی)،
 * چون کارش رصد دائمی بازاره. راهنمای دیپلوی در README.md هست.
 */

const WebSocket = require("ws");

// ---------------- تنظیمات (از متغیرهای محیطی) ----------------
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const THRESHOLD_PERCENT  = parseFloat(process.env.THRESHOLD_PERCENT || "5");   // آستانه‌ی پامپ
const WINDOW_MINUTES     = parseFloat(process.env.WINDOW_MINUTES || "5");     // بازه‌ی زمانی رشد
const HYSTERESIS_PERCENT = parseFloat(process.env.HYSTERESIS_PERCENT || "1.5"); // برای جلوگیری از اسپم
const QUOTE_SUFFIX       = process.env.QUOTE_SUFFIX || "USDT"; // فقط جفت‌های این ارز رصد بشه

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error("خطا: TELEGRAM_BOT_TOKEN و TELEGRAM_CHAT_ID رو به‌عنوان متغیر محیطی تنظیم کن (راهنما در README.md).");
  process.exit(1);
}

const WINDOW_MS = WINDOW_MINUTES * 60 * 1000;
const BUFFER_MS = WINDOW_MS + 30 * 1000; // کمی بیشتر از بازه، برای دقت بهتر در پیدا کردن قیمت پایه

// symbol -> [{t, p}, ...]  (تاریخچه‌ی قیمت هر نماد، فقط داخل بازه‌ی زمانی نگه داشته می‌شه)
const history = new Map();
// symbol -> bool  (آیا الان بالای آستانه هست و قبلاً اطلاع داده شده)
const notified = new Map();

let lastEvalAt = 0;
const EVAL_INTERVAL_MS = 15000; // هر ۱۵ ثانیه یک‌بار بررسی می‌کنیم (نه هر تیک، برای کاهش بار)

function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: text }),
  }).catch((err) => console.error("خطا در ارسال پیام تلگرام:", err.message));
}

function pushPrice(symbol, price, now) {
  let arr = history.get(symbol);
  if (!arr) {
    arr = [];
    history.set(symbol, arr);
  }
  arr.push({ t: now, p: price });
  // حذف داده‌های قدیمی‌تر از بافر
  while (arr.length && now - arr[0].t > BUFFER_MS) arr.shift();
}

function evaluate(now) {
  for (const [symbol, arr] of history.entries()) {
    if (arr.length < 2) continue;
    // قدیمی‌ترین نقطه‌ای که حداقل به اندازه‌ی بازه‌ی موردنظر عقب‌تره (تقریبی)
    let base = arr[0];
    for (let i = 0; i < arr.length; i++) {
      if (now - arr[i].t <= WINDOW_MS) { base = arr[i]; break; }
      base = arr[i];
    }
    const latest = arr[arr.length - 1];
    if (!base || base.p <= 0) continue;
    const changePct = ((latest.p - base.p) / base.p) * 100;

    const wasNotified = notified.get(symbol) || false;
    if (changePct >= THRESHOLD_PERCENT) {
      if (!wasNotified) {
        notified.set(symbol, true);
        const name = symbol.replace(QUOTE_SUFFIX, "");
        sendTelegram(
          `🚀 پامپ شناسایی شد: ${name}\n` +
          `رشد ${changePct.toFixed(1)}٪ در ${WINDOW_MINUTES} دقیقه‌ی اخیر\n` +
          `قیمت فعلی: ${latest.p}`
        );
        console.log(`[ALERT] ${symbol} +${changePct.toFixed(2)}%`);
      }
    } else if (changePct < THRESHOLD_PERCENT - HYSTERESIS_PERCENT) {
      notified.set(symbol, false);
    }
  }
}

function connect() {
  console.log("در حال اتصال به بایننس...");
  const ws = new WebSocket("wss://stream.binance.com:9443/ws/!miniTicker@arr");

  ws.on("open", () => {
    console.log("متصل شد. شروع رصد بازار...");
    sendTelegram(`✅ پامپ‌یاب فعال شد. آستانه: ${THRESHOLD_PERCENT}٪ در ${WINDOW_MINUTES} دقیقه.`);
  });

  ws.on("message", (raw) => {
    let list;
    try { list = JSON.parse(raw); } catch (e) { return; }
    if (!Array.isArray(list)) return;
    const now = Date.now();
    for (const t of list) {
      const symbol = t.s; // مثل BTCUSDT
      if (!symbol || !symbol.endsWith(QUOTE_SUFFIX)) continue;
      const price = parseFloat(t.c);
      if (!price) continue;
      pushPrice(symbol, price, now);
    }
    if (now - lastEvalAt >= EVAL_INTERVAL_MS) {
      lastEvalAt = now;
      evaluate(now);
    }
  });

  ws.on("close", () => {
    console.log("اتصال قطع شد. تلاش مجدد در ۵ ثانیه...");
    setTimeout(connect, 5000);
  });

  ws.on("error", (err) => {
    console.error("خطای اتصال:", err.message);
    ws.close();
  });
}

connect();

// یه سرور HTTP خیلی ساده فقط برای اینکه پلتفرم‌های میزبانی (Railway/Render)
// تشخیص بدن که سرویس زنده‌ست (بعضی‌هاشون به یه پورت باز نیاز دارن).
const http = require("http");
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("پامپ‌یاب در حال اجراست.\nنمادهای تحت رصد: " + history.size);
}).listen(PORT, () => console.log("سرور وضعیت روی پورت " + PORT + " بالا اومد."));
