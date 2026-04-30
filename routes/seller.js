const express  = require("express");
const router   = express.Router();
const db       = require("../db");
const https    = require("https");
const http     = require("http");

// ── GET all seller records ──
router.get("/", (req, res) => {
  const rows = db.all("SELECT * FROM seller_records ORDER BY start_date DESC");
  return res.json(rows); 
});

// ── POST new seller record ──
router.post("/", (req, res) => {
  const { seller_name, start_date, end_date, price_per_hour, note } = req.body;
  if (!seller_name || !start_date || !end_date || !price_per_hour)
    return res.status(400).json({ error: "Missing required fields" });

  const start = new Date(start_date).getTime();
  const end   = new Date(end_date).getTime();
  
  if (isNaN(start) || isNaN(end) || end < start)
    return res.status(400).json({ error: "Invalid date range" });

  const hours_worked = Math.max(0, (end - start) / 3600000);
  const total_price  = Math.round(hours_worked * parseFloat(price_per_hour));
  const created_at   = Date.now();

  try {
    db.run(
      `INSERT INTO seller_records (seller_name, start_date, end_date, price_per_hour, hours_worked, total_price, note, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [seller_name, start_date, end_date, price_per_hour, hours_worked, total_price, note || "", created_at]
    );

    // 웹훅 전송 시 사용할 ID 확보
    const lastRecord = db.get("SELECT id FROM seller_records ORDER BY id DESC LIMIT 1");

    return res.json({ ok: true, id: lastRecord.id, hours_worked, total_price });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ── Discord Webhook 전송 ──
router.post("/notify", async (req, res) => {
  const { webhook_url, content: customContent, image_base64, image_mime } = req.body;
  if (!webhook_url) return res.status(400).json({ error: "Webhook URL missing" });

  try {
    const content = customContent || "📸 정산 스크린샷";

    if (image_base64) {
      // 이미지 첨부 — multipart/form-data
      const imgBuffer = Buffer.from(image_base64, "base64");
      const ext       = (image_mime || "image/png").split("/")[1];
      const boundary  = "----MapleFormBoundary" + Date.now();

      const partHead = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="payload_json"\r\n\r\n` +
        JSON.stringify({ content }) +
        `\r\n--${boundary}\r\nContent-Disposition: form-data; name="files[0]"; filename="screenshot.${ext}"\r\nContent-Type: ${image_mime || "image/png"}\r\n\r\n`,
        "utf8"
      );
      const partTail  = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
      const fullBody  = Buffer.concat([partHead, imgBuffer, partTail]);
      await sendWebhook(webhook_url, fullBody, `multipart/form-data; boundary=${boundary}`);
    } else {
      const payload = Buffer.from(JSON.stringify({ content }), "utf8");
      await sendWebhook(webhook_url, payload, "application/json");
    }

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// /webhook 은 하위 호환용 alias
router.post("/webhook", async (req, res) => {
  req.url = "/notify";
  router.handle(req, res, () => {});
});

function sendWebhook(url, body, contentType) {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(url);
    const lib     = parsed.protocol === "https:" ? https : http;
    const options = {
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      method:   "POST",
      headers:  {
        "Content-Type":   contentType,
        "Content-Length": body.length,
      },
    };
    const req = lib.request(options, (r) => {
      let data = "";
      r.on("data", chunk => data += chunk);
      r.on("end", () => resolve(data));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

module.exports = router;
