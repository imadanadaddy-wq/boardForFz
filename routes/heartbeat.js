const express = require("express");
const router  = express.Router();
const db      = require("../db");

router.post("/", async (req, res) => {
  const { ign, owner, token, level, world_id, channel, map_id, client_tick } = req.body;
  if (!ign || !owner || !token)
    return res.status(400).json({ error: "Missing: ign, owner, token" });
  const client = db.get("SELECT * FROM clients WHERE owner = ?", [owner]);
  if (!client) return res.status(401).json({ error: "Unknown owner" });
  if (client.token !== token) return res.status(401).json({ error: "Invalid token" });
  const now  = Date.now();
  const prev = db.get("SELECT channel, map_id FROM heartbeats WHERE owner=? AND ign=?", [owner, ign]);
  db.run(`INSERT INTO heartbeats (owner,ign,level,world_id,channel,map_id,client_tick,last_seen)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(owner,ign) DO UPDATE SET
      level=excluded.level, world_id=excluded.world_id, channel=excluded.channel,
      map_id=excluded.map_id, client_tick=excluded.client_tick, last_seen=excluded.last_seen`,
    [owner, ign, level||0, world_id??null, channel??null, map_id??null, client_tick??null, now]);
  // 변경 감지 — 기존 row 있을 때만
  if (prev) {
    const oldCh  = prev.channel  ?? null;
    const oldMap = prev.map_id   ?? null;
    const newCh  = channel  ?? null;
    const newMap = map_id   ?? null;
    if (String(oldCh)  !== String(newCh))
      db.run("INSERT INTO bot_change_log (ts,owner,ign,field,old_val,new_val) VALUES (?,?,?,?,?,?)",
        [now, owner, ign, "channel", String(oldCh), String(newCh)]);
    if (String(oldMap) !== String(newMap))
      db.run("INSERT INTO bot_change_log (ts,owner,ign,field,old_val,new_val) VALUES (?,?,?,?,?,?)",
        [now, owner, ign, "map_id", String(oldMap), String(newMap)]);
  }
  return res.json({ ok: true, ts: now });
});

router.get("/", (req, res) => {
  const STALE = 120_000;
  const now   = Date.now();
  const rows  = db.all("SELECT owner,ign,level,world_id,channel,map_id,last_seen FROM heartbeats ORDER BY owner,ign");

  // ★ forced_offline 테이블에서 강제 오프 목록 로드
  const forced = new Set(
    db.all("SELECT owner, ign FROM forced_offline")
      .map(r => r.owner + "|" + r.ign)
  );

  return res.json(rows.map(r => {
    const isForced = forced.has(r.owner + "|" + r.ign);
    return {
      ...r,
      online:  !isForced && (now - r.last_seen) < STALE,
      forced:  isForced,
      ago_sec: Math.floor((now - r.last_seen) / 1000),
    };
  }));
});

module.exports = router;
