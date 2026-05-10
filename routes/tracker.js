const express  = require("express");
const router   = express.Router();
const db       = require("../db");
const jwt      = require("jsonwebtoken");
const { checkMesoAlert } = require("./management");

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

const HISTORY_INTERVAL = 30 * 60 * 1000;
const _svrHistory = {};
const SVR_MAX_DIFF    = 8_000_000;
const SVR_MAX_DT_MS   = 90_000;
const SVR_MESO_HR_CAP = 400_000_000;

function svrCalcMesoHr(owner, ign, meso) {
  const key = owner + "|" + ign;
  const now = Date.now();
  if (!_svrHistory[key]) _svrHistory[key] = { samples: [], lastMeso: null, lastTs: null };
  const h = _svrHistory[key];
  if (h.lastMeso != null && h.lastTs != null) {
    const dt_ms = now - h.lastTs;
    const diff  = meso - h.lastMeso;
    if (dt_ms > SVR_MAX_DT_MS) {
      h.samples = [];
    } else if (dt_ms > 0 && diff >= 0 && diff < SVR_MAX_DIFF) {
      const rate = Math.floor((diff / dt_ms) * 3_600_000);
      h.samples.push(rate);
      while (h.samples.length > 12) h.samples.shift();
    }
  }
  h.lastMeso = meso;
  h.lastTs   = now;
  if (h.samples.length < 2) return null;
  return Math.floor(h.samples.reduce((a, b) => a + b, 0) / h.samples.length);
}

// 우회 로그인
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

// POST: 봇 하트비트
router.post("/", (req, res) => {
  const { owner, token, ign, level, meso, meso_hr: lua_meso_hr, items, buff_count } = req.body;
  if (!owner || !token || !ign)
    return res.status(400).json({ error: "Missing fields" });
  const client = db.get("SELECT * FROM tokens WHERE owner = ?", [owner]);
  if (!client)                return res.status(401).json({ error: "Unknown owner" });
  if (client.token !== token) return res.status(401).json({ error: "Invalid token" });

  const now     = Date.now();
  const mesoNum = Number(meso) || 0;
  const luaHr   = Number(lua_meso_hr) || 0;
  const buffCnt = (buff_count !== undefined && buff_count !== null) ? Number(buff_count) : null;

  const svrHr = svrCalcMesoHr(owner, ign, mesoNum);
  let verified_meso_hr;
  if (svrHr === null) {
    verified_meso_hr = Math.min(luaHr, SVR_MESO_HR_CAP);
  } else {
    const diff    = Math.abs(luaHr - svrHr);
    const maxVal  = Math.max(luaHr, svrHr, 1);
    const diffPct = diff / maxVal;
    verified_meso_hr = diffPct <= 0.3
      ? Math.round((luaHr + svrHr) / 2)
      : Math.min(luaHr, svrHr);
    verified_meso_hr = Math.min(verified_meso_hr, SVR_MESO_HR_CAP);
  }

  db.run(
    `INSERT INTO private_data (owner,ign,level,meso,meso_hr,items,last_seen,buff_count)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(owner,ign) DO UPDATE SET
       level=excluded.level, meso=excluded.meso, meso_hr=excluded.meso_hr,
       items=excluded.items, last_seen=excluded.last_seen, buff_count=excluded.buff_count`,
    [owner, ign, level||0, mesoNum, verified_meso_hr, JSON.stringify(items||[]), now, buffCnt]
  );

  const last = db.get(
    "SELECT ts FROM meso_history WHERE owner=? AND ign=? ORDER BY ts DESC LIMIT 1",
    [owner, ign]
  );
  if (!last || (now - last.ts) >= HISTORY_INTERVAL) {
    db.run(
      "INSERT INTO meso_history (owner,ign,meso,meso_hr,ts) VALUES (?,?,?,?,?)",
      [owner, ign, mesoNum, verified_meso_hr, now]
    );
  }

  let isForcedOffline = false;
  try {
    const row = db.get("SELECT 1 FROM forced_offline WHERE owner=? AND ign=?", [owner, ign]);
    isForcedOffline = !!row;
  } catch(e) {}

  checkMesoAlert(owner, ign, level || 0, verified_meso_hr || null, true, isForcedOffline);

  return res.json({ ok: true, verified_meso_hr, svr_hr: svrHr, lua_hr: luaHr });
});

// GET: 대시보드용 봇 데이터
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
