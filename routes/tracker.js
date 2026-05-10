const express = require("express");
const router  = express.Router();
const db      = require("../db");
const jwt     = require("jsonwebtoken");

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

const HISTORY_INTERVAL = 30 * 60 * 1000; // 30분

// ── 서버 측 meso/hr 계산 상태 (메모리) ──
const _svrHistory = {}; // { [owner|ign]: { samples: [], lastMeso, lastTs } }

const SVR_MAX_DIFF    = 8_000_000;   // 구간당 허용 최대 상승 (8m)
const SVR_MAX_DT_MS   = 90_000;      // 90초 초과 시 히스토리 리셋
const SVR_MESO_HR_CAP = 400_000_000; // 400m/hr 절대 상한 (하드 클램프)

function svrCalcMesoHr(owner, ign, meso) {
  const key = owner + "|" + ign;
  const now = Date.now();
  if (!_svrHistory[key]) _svrHistory[key] = { samples: [], lastMeso: null, lastTs: null };
  const h = _svrHistory[key];

  if (h.lastMeso != null && h.lastTs != null) {
    const dt_ms = now - h.lastTs;
    const diff  = meso - h.lastMeso;

    if (dt_ms > SVR_MAX_DT_MS) {
      h.samples = []; // 봇 재시작 or 긴 공백 → 리셋
    } else if (dt_ms > 0 && diff >= 0 && diff < SVR_MAX_DIFF) {
      const rate = Math.floor((diff / dt_ms) * 3_600_000);
      h.samples.push(rate);
      while (h.samples.length > 12) h.samples.shift(); // 6분 윈도우 (30s×12)
    }
    // diff < 0 또는 너무 큰 점프 → 현재 샘플만 스킵 (히스토리 유지)
  }

  h.lastMeso = meso;
  h.lastTs   = now;

  if (h.samples.length < 2) return null; // 샘플 부족 → 판단 보류
  return Math.floor(h.samples.reduce((a, b) => a + b, 0) / h.samples.length);
}

router.post("/", (req, res) => {
  const { owner, token, ign, level, meso, meso_hr: lua_meso_hr, items } = req.body;
  if (!owner || !token || !ign)
    return res.status(400).json({ error: "Missing fields" });
  const client = db.get("SELECT * FROM tokens WHERE owner = ?", [owner]);
  if (!client)                return res.status(401).json({ error: "Unknown owner" });
  if (client.token !== token) return res.status(401).json({ error: "Invalid token" });

  const now     = Date.now();
  const mesoNum = Number(meso) || 0;
  const luaHr   = Number(lua_meso_hr) || 0;

  // ── 서버 측 meso/hr 계산 ──
  const svrHr = svrCalcMesoHr(owner, ign, mesoNum);

  // ── 교차 검증 ──
  // 서버 샘플 부족 → 루아값 신뢰(클램프만)
  // 서버값 있음  → 차이 30% 이내면 평균, 그 이상이면 낮은 쪽 채택
  let verified_meso_hr;
  if (svrHr === null) {
    verified_meso_hr = Math.min(luaHr, SVR_MESO_HR_CAP);
  } else {
    const diff    = Math.abs(luaHr - svrHr);
    const maxVal  = Math.max(luaHr, svrHr, 1);
    const diffPct = diff / maxVal;

    if (diffPct <= 0.3) {
      verified_meso_hr = Math.round((luaHr + svrHr) / 2);
    } else {
      verified_meso_hr = Math.min(luaHr, svrHr);
    }
    verified_meso_hr = Math.min(verified_meso_hr, SVR_MESO_HR_CAP);
  }

  db.run(`INSERT INTO private_data (owner,ign,level,meso,meso_hr,items,last_seen)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(owner,ign) DO UPDATE SET
      level=excluded.level,meso=excluded.meso,meso_hr=excluded.meso_hr,
      items=excluded.items,last_seen=excluded.last_seen`,
    [owner, ign, level||0, mesoNum, verified_meso_hr, JSON.stringify(items||[]), now]);

  // ── meso 스냅샷: 첫 기록은 즉시, 이후 30분마다 ──
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

  return res.json({ ok: true, verified_meso_hr, svr_hr: svrHr, lua_hr: luaHr });
});

router.get("/", requireAuth, (req, res) => {
  const now  = Date.now();
  const rows = db.all("SELECT * FROM private_data ORDER BY meso_hr DESC");
  return res.json(rows.map(r => ({
    ...r, items: JSON.parse(r.items||"[]"),
    online: (now-r.last_seen)<120000,
    ago_sec: Math.floor((now-r.last_seen)/1000)
  })));
});

// 개별 캐릭터 meso 히스토리 (최근 48시간)
router.get("/history/:ign", requireAuth, (req, res) => {
  const since = Date.now() - 48 * 60 * 60 * 1000;
  const rows  = db.all(
    "SELECT meso, meso_hr, ts FROM meso_history WHERE ign=? AND ts>=? ORDER BY ts ASC",
    [req.params.ign, since]
  );
  return res.json(rows);
});

// 전체 캐릭터 최근 히스토리 (그래프 탭용)
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
