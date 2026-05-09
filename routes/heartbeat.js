const express = require("express");
const router  = express.Router();
const db      = require("../db");

// ── Lv.219 이하 자동 FORCED 임계값 ──
const AUTO_FORCE_LEVEL = 219;

// 수동 해제된 봇 추적 (메모리, 서버 재시작 시 초기화되나 DB에서 재계산)
// key: "owner|ign"
// 서버 DB의 forced_offline에는 "자동강제"와 "수동강제" 모두 저장되므로,
// 수동 해제를 구분하기 위해 별도 테이블 manual_released를 사용
function ensureManualReleasedTable() {
  db.run(`
    CREATE TABLE IF NOT EXISTS manual_released (
      owner TEXT NOT NULL,
      ign   TEXT NOT NULL,
      PRIMARY KEY (owner, ign)
    )
  `);
}

router.post("/", async (req, res) => {
  const { ign, owner, token, level, world_id, channel, map_id, client_tick } = req.body;
  if (!ign || !owner || !token)
    return res.status(400).json({ error: "Missing: ign, owner, token" });
  const client = db.get("SELECT * FROM clients WHERE owner = ?", [owner]);
  if (!client) return res.status(401).json({ error: "Unknown owner" });
  if (client.token !== token) return res.status(401).json({ error: "Invalid token" });

  ensureManualReleasedTable();

  const now  = Date.now();
  const prev = db.get("SELECT channel, map_id FROM heartbeats WHERE owner=? AND ign=?", [owner, ign]);
  db.run(`INSERT INTO heartbeats (owner,ign,level,world_id,channel,map_id,client_tick,last_seen)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(owner,ign) DO UPDATE SET
      level=excluded.level, world_id=excluded.world_id, channel=excluded.channel,
      map_id=excluded.map_id, client_tick=excluded.client_tick, last_seen=excluded.last_seen`,
    [owner, ign, level||0, world_id??null, channel??null, map_id??null, client_tick??null, now]);

  // 변경 감지
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

  // ── Lv.219 이하 자동 FORCED 처리 ──
  const lvNum = Number(level) || 0;
  if (lvNum > 0 && lvNum <= AUTO_FORCE_LEVEL) {
    // 이미 forced 상태인지 확인
    const alreadyForced = db.get(
      "SELECT 1 FROM forced_offline WHERE owner=? AND ign=?", [owner, ign]
    );
    // 수동 해제된 봇인지 확인
    const manuallyReleased = db.get(
      "SELECT 1 FROM manual_released WHERE owner=? AND ign=?", [owner, ign]
    );

    // 아직 forced 아니고, 수동 해제도 아니라면 → 자동 FORCED
    if (!alreadyForced && !manuallyReleased) {
      db.run(
        "INSERT OR IGNORE INTO forced_offline (owner, ign, forced_at) VALUES (?, ?, ?)",
        [owner, ign, now]
      );
    }
  }

  return res.json({ ok: true, ts: now });
});

// ── GET: 수동 해제 API ──
// DELETE /api/bot-heartbeat/client 와 구별하기 위해 forced-offline 라우트에서 처리하지만,
// heartbeat 라우터에서도 manual_released 등록을 위한 엔드포인트 제공
router.delete("/manual-release", (req, res) => {
  const { owner, ign, token } = req.body || {};
  if (!owner || !ign || !token)
    return res.status(400).json({ error: "owner, ign, token required" });
  const client = db.get("SELECT token FROM clients WHERE owner=?", [owner]);
  if (!client || client.token !== token)
    return res.status(403).json({ error: "Invalid token" });

  ensureManualReleasedTable();

  // 강제 오프라인 해제 + 수동 해제 기록 (재자동강제 방지)
  db.run("DELETE FROM forced_offline WHERE owner=? AND ign=?", [owner, ign]);
  db.run("INSERT OR IGNORE INTO manual_released (owner, ign) VALUES (?, ?)", [owner, ign]);
  return res.json({ ok: true, owner, ign, manuallyReleased: true });
});

// ── GET: heartbeat 목록 ──
router.get("/", (req, res) => {
  const STALE = 120_000;
  const now   = Date.now();
  const rows  = db.all("SELECT owner,ign,level,world_id,channel,map_id,last_seen FROM heartbeats ORDER BY owner,ign");

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
