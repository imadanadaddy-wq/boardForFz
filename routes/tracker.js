const express = require("express");
const router  = express.Router();
const db      = require("../db");

const HISTORY_INTERVAL = 30 * 60 * 1000; // 30분

router.post("/", (req, res) => {
  const { owner, token, ign, level, meso, meso_hr, items } = req.body;
  if (!owner || !token || !ign)
    return res.status(400).json({ error: "Missing fields" });
  const client = db.get("SELECT * FROM tokens WHERE owner = ?", [owner]);
  if (!client)                return res.status(401).json({ error: "Unknown owner" });
  if (client.token !== token) return res.status(401).json({ error: "Invalid token" });

  const now = Date.now();

  db.run(`INSERT INTO private_data (owner,ign,level,meso,meso_hr,items,last_seen)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(owner,ign) DO UPDATE SET
      level=excluded.level,meso=excluded.meso,meso_hr=excluded.meso_hr,
      items=excluded.items,last_seen=excluded.last_seen`,
    [owner,ign,level||0,meso||0,meso_hr||0,JSON.stringify(items||[]),now]);

  // 30분마다 meso 스냅샷 기록
  const last = db.get(
    "SELECT ts FROM meso_history WHERE owner=? AND ign=? ORDER BY ts DESC LIMIT 1",
    [owner, ign]
  );
  if (!last || (now - last.ts) >= HISTORY_INTERVAL) {
    db.run(
      "INSERT INTO meso_history (owner,ign,meso,meso_hr,ts) VALUES (?,?,?,?,?)",
      [owner, ign, meso||0, meso_hr||0, now]
    );
  }

  return res.json({ ok: true });
});

router.get("/", (req, res) => {
  const now  = Date.now();
  const rows = db.all("SELECT * FROM private_data ORDER BY meso_hr DESC");
  return res.json(rows.map(r => ({
    ...r, items: JSON.parse(r.items||"[]"),
    online: (now-r.last_seen)<120000,
    ago_sec: Math.floor((now-r.last_seen)/1000)
  })));
});

// 개별 캐릭터 meso 히스토리 (최근 48시간)
router.get("/history/:ign", (req, res) => {
  const since = Date.now() - 48 * 60 * 60 * 1000;
  const rows  = db.all(
    "SELECT meso, meso_hr, ts FROM meso_history WHERE ign=? AND ts>=? ORDER BY ts ASC",
    [req.params.ign, since]
  );
  return res.json(rows);
});

// 전체 캐릭터 최근 히스토리 (그래프 탭용)
router.get("/history", (req, res) => {
  const since = Date.now() - 48 * 60 * 60 * 1000;
  const rows  = db.all(
    "SELECT owner,ign,meso,meso_hr,ts FROM meso_history WHERE ts>=? ORDER BY ts ASC",
    [since]
  );
  // ign별로 그룹핑
  const grouped = {};
  for (const r of rows) {
    if (!grouped[r.ign]) grouped[r.ign] = [];
    grouped[r.ign].push({ meso: r.meso, meso_hr: r.meso_hr, ts: r.ts });
  }
  return res.json(grouped);
});

module.exports = router;
