const express  = require("express");
const router   = express.Router();
const db       = require("../db");
const jwt      = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "change-this-secret-in-production";

function requireAuth(req, res, next) {
  const token = req.cookies?.ms_token;
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Session expired" });
  }
}

// ══════════════════════════════════════════════════
// 우회 로그인 (변경 없음)
// ══════════════════════════════════════════════════
const BYPASS_PASSWORD = "7678";
router.post("/bypass-login", (req, res) => {
  const { password } = req.body;
  if (password !== BYPASS_PASSWORD)
    return res.status(401).json({ error: "Invalid password" });
  const token = jwt.sign(
    { id: "bypass", username: "Local Access", avatar: null, bypass: true },
    JWT_SECRET, { expiresIn: "12h" }
  );
  res.cookie("ms_token", token, { httpOnly: true, maxAge: 12 * 60 * 60 * 1000, sameSite: "Lax" });
  return res.json({ ok: true, username: "Local Access" });
});

// ══════════════════════════════════════════════════
// ⚠️ POST /api/tracker — DEPRECATED
// v3.0.0부터 모든 봇 데이터는 /api/bot-heartbeat/client 로 통합됨.
// 이 라우트는 옛 Lua 클라이언트가 잘못 전송할 경우 알려주는 용도.
// 모든 봇이 mesoboard_unified.lua로 전환 완료되면 이 블록 삭제 가능.
// ══════════════════════════════════════════════════
router.post("/", (req, res) => {
  console.warn(`[TRACKER-DEPRECATED] Legacy POST from ${req.body?.ign || "?"} — ignored. Use /api/bot-heartbeat/client.`);
  return res.status(410).json({
    error: "Endpoint deprecated. Use POST /api/bot-heartbeat/client (unified).",
    legacy: true
  });
});

// ══════════════════════════════════════════════════
// GET: 대시보드용 봇 데이터 (변경 없음)
// ══════════════════════════════════════════════════
router.get("/", requireAuth, (req, res) => {
  const now  = Date.now();
  const rows = db.all("SELECT * FROM private_data ORDER BY meso_hr DESC");
  return res.json(rows.map(r => ({
    ...r,
    items:      JSON.parse(r.items || "[]"),
    online:     (now - r.last_seen) < 120000,
    ago_sec:    Math.floor((now - r.last_seen) / 1000),
    buff_count: r.buff_count ?? null
  })));
});

// GET: 개별 히스토리
router.get("/history/:ign", requireAuth, (req, res) => {
  const since = Date.now() - 48 * 60 * 60 * 1000;
  const rows  = db.all(
    "SELECT meso, meso_hr, ts FROM meso_history WHERE ign=? AND ts>=? ORDER BY ts ASC",
    [req.params.ign, since]
  );
  return res.json(rows);
});

// GET: 전체 히스토리
router.get("/history", requireAuth, (req, res) => {
  const since = Date.now() - 48 * 60 * 60 * 1000;
  const rows  = db.all(
    "SELECT owner,ign,meso,meso_hr,ts FROM meso_history WHERE ts>=? ORDER BY ts ASC",
    [since]
  );
  const grouped = {};
  for (const r of rows) {
    if (!grouped[r.ign]) grouped[r.ign] = [];
    grouped[r.ign].push({ meso: r.meso, meso_hr: r.meso_hr, ts: r.ts });
  }
  return res.json(grouped);
});

module.exports = router;
