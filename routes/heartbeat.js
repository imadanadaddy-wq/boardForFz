const express = require("express");
const router  = express.Router();
const db      = require("../db");
const { checkMesoAlert } = require("./management");

const AUTO_FORCE_LEVEL = 219;
const HISTORY_INTERVAL = 30 * 60 * 1000;

// ── server-side meso/hr verification (cross-check vs Lua client) ──
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

function ensureManualReleasedTable() {
  db.run(`
    CREATE TABLE IF NOT EXISTS manual_released (
      owner TEXT NOT NULL,
      ign   TEXT NOT NULL,
      PRIMARY KEY (owner, ign)
    )
  `);
}

// ══════════════════════════════════════════════════
// POST /api/bot-heartbeat/client
// 통합 엔드포인트 — 모든 데이터를 받음
// (heartbeat 호환 필드는 그대로, meso/items는 추가로 받음)
// ══════════════════════════════════════════════════
router.post("/", (req, res) => {
  const {
    // ── heartbeat 필드 (필수, 프렌지 캐스트 호환) ──
    ign, owner, token, level, world_id, channel, map_id, client_tick,
    // ── meso tracker 필드 (선택, 새 통합 Lua가 함께 보냄) ──
    meso, meso_hr: lua_meso_hr, items, buff_count, job,
    // ── evasion 콜백 (선택, on_evasion 트리거 시) ──
    evasion_by, evasion_ts,
  } = req.body;

  if (!ign || !owner || !token)
    return res.status(400).json({ error: "Missing: ign, owner, token" });

  // ── 토큰 검증: tokens 또는 clients 테이블 둘 다 허용 ──
  const tokRow = db.get("SELECT token FROM tokens  WHERE owner=?", [owner])
              || db.get("SELECT token FROM clients WHERE owner=?", [owner]);
  if (!tokRow)              return res.status(401).json({ error: "Unknown owner" });
  if (tokRow.token !== token) return res.status(401).json({ error: "Invalid token" });

  ensureManualReleasedTable();

  const now      = Date.now();
  const hasMeso  = meso !== undefined && meso !== null;
  const mesoNum  = hasMeso ? Number(meso) : null;
  const luaHr    = Number(lua_meso_hr) || 0;
  const buffCnt  = (buff_count !== undefined && buff_count !== null) ? Number(buff_count) : null;

  // ─────────────────────────────────────────────
  // 1) HEARTBEATS 테이블 — 기존 동작 (프렌지 봇이 이걸 읽음)
  // ─────────────────────────────────────────────
  const prevHb = db.get("SELECT channel, map_id FROM heartbeats WHERE owner=? AND ign=?", [owner, ign]);
  db.run(`INSERT INTO heartbeats (owner,ign,level,world_id,channel,map_id,client_tick,last_seen)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(owner,ign) DO UPDATE SET
      level=excluded.level, world_id=excluded.world_id, channel=excluded.channel,
      map_id=excluded.map_id, client_tick=excluded.client_tick, last_seen=excluded.last_seen`,
    [owner, ign, level||0, world_id ?? null, channel ?? null, map_id ?? null, client_tick ?? null, now]);

  // channel/map 변경 감지 (change log)
  if (prevHb) {
    const oldCh  = prevHb.channel ?? null;
    const oldMap = prevHb.map_id  ?? null;
    const newCh  = channel ?? null;
    const newMap = map_id  ?? null;
    if (String(oldCh) !== String(newCh))
      db.run("INSERT INTO bot_change_log (ts,owner,ign,field,old_val,new_val) VALUES (?,?,?,?,?,?)",
        [now, owner, ign, "channel", String(oldCh), String(newCh)]);
    if (String(oldMap) !== String(newMap))
      db.run("INSERT INTO bot_change_log (ts,owner,ign,field,old_val,new_val) VALUES (?,?,?,?,?,?)",
        [now, owner, ign, "map_id", String(oldMap), String(newMap)]);
  }

  // ─────────────────────────────────────────────
  // 2) Lv.219 이하 자동 FORCED 처리 (기존 로직 유지)
  // ─────────────────────────────────────────────
  const lvNum = Number(level) || 0;
  if (lvNum > 0 && lvNum <= AUTO_FORCE_LEVEL) {
    const alreadyForced = db.get(
      "SELECT 1 FROM forced_offline WHERE owner=? AND ign=?", [owner, ign]
    );
    const manuallyReleased = db.get(
      "SELECT 1 FROM manual_released WHERE owner=? AND ign=?", [owner, ign]
    );
    if (!alreadyForced && !manuallyReleased) {
      db.run(
        "INSERT OR IGNORE INTO forced_offline (owner, ign, forced_at) VALUES (?, ?, ?)",
        [owner, ign, now]
      );
    }
  }

  // ─────────────────────────────────────────────
  // 3) PRIVATE_DATA + MESO_HISTORY — meso 필드가 같이 왔을 때만 실행
  //    (legacy heartbeat-only 봇과의 호환을 위해 conditional)
  // ─────────────────────────────────────────────
  if (hasMeso) {
    const prevPd = db.get("SELECT buff_count FROM private_data WHERE owner=? AND ign=?", [owner, ign]);

    // buff_count 변경 감지 (사망 이벤트)
    if (buffCnt !== null && prevPd && prevPd.buff_count !== buffCnt) {
      db.run(
        "INSERT INTO bot_change_log (ts,owner,ign,field,old_val,new_val) VALUES (?,?,?,?,?,?)",
        [now, owner, ign, "buff_count", String(prevPd.buff_count || 0), String(buffCnt)]
      );
    }

    // 서버 측 meso/hr 교차 검증
    const svrHr = svrCalcMesoHr(owner, ign, mesoNum);
    let verified_meso_hr;
    if (svrHr === null) {
      verified_meso_hr = Math.min(luaHr, SVR_MESO_HR_CAP);
    } else {
      const diff   = Math.abs(luaHr - svrHr);
      const maxVal = Math.max(luaHr, svrHr, 1);
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
      [owner, ign, lvNum, mesoNum, verified_meso_hr, JSON.stringify(items || []), now, buffCnt]
    );

    // 30분마다 히스토리 샘플
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

    // 메소 알람 평가
    let isForcedOffline = false;
    try {
      const row = db.get("SELECT 1 FROM forced_offline WHERE owner=? AND ign=?", [owner, ign]);
      isForcedOffline = !!row;
    } catch(e) {}
    checkMesoAlert(owner, ign, lvNum, verified_meso_hr || null, true, isForcedOffline);
  }

  // ─────────────────────────────────────────────
  // 4) Evasion 이벤트 (on_evasion 콜백 결과)
  // ─────────────────────────────────────────────
  if (evasion_by) {
    db.run(
      "INSERT INTO bot_change_log (ts,owner,ign,field,old_val,new_val) VALUES (?,?,?,?,?,?)",
      [Number(evasion_ts) || now, owner, ign, "evasion", "", String(evasion_by)]
    );
    console.log(`[EVASION] ${ign} evaded by: ${evasion_by}`);
  }

  return res.json({ ok: true, ts: now });
});

// ══════════════════════════════════════════════════
// DELETE /manual-release (기존 그대로)
// ══════════════════════════════════════════════════
router.delete("/manual-release", (req, res) => {
  const { owner, ign, token } = req.body || {};
  if (!owner || !ign || !token)
    return res.status(400).json({ error: "owner, ign, token required" });
  const client = db.get("SELECT token FROM clients WHERE owner=?", [owner])
              || db.get("SELECT token FROM tokens  WHERE owner=?", [owner]);
  if (!client || client.token !== token)
    return res.status(403).json({ error: "Invalid token" });

  ensureManualReleasedTable();
  db.run("DELETE FROM forced_offline WHERE owner=? AND ign=?", [owner, ign]);
  db.run("INSERT OR IGNORE INTO manual_released (owner, ign) VALUES (?, ?)", [owner, ign]);
  return res.json({ ok: true, owner, ign, manuallyReleased: true });
});

// ══════════════════════════════════════════════════
// GET /api/bot-heartbeat/client (기존 그대로 — 프렌지 봇이 읽음)
// ══════════════════════════════════════════════════
router.get("/", (req, res) => {
  const STALE = 120_000;
  const now   = Date.now();
  const rows  = db.all(
    "SELECT owner,ign,level,world_id,channel,map_id,last_seen FROM heartbeats ORDER BY owner,ign"
  );
  const forced = new Set(
    db.all("SELECT owner, ign FROM forced_offline").map(r => r.owner + "|" + r.ign)
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
