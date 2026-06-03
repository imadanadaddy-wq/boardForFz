const express = require("express");
const router  = express.Router();
const db      = require("../db");
const { checkMesoAlert } = require("./management");

const AUTO_FORCE_LEVEL  = 219;
const HISTORY_INTERVAL  = 30 * 60 * 1000;

// ── server-side meso/hr verification ──
const _svrHistory     = {};
const SVR_MAX_DIFF    = 8_000_000;
const SVR_MAX_DT_MS   = 90_000;
const SVR_STALE_MS    = 120_000;    // 2분간 유효 샘플 없으면 클리어
const SVR_WINDOW      = 5;          // 12→5: 빠른 반응
const SVR_MESO_HR_CAP = 400_000_000;

// ── evasion dedupe: 같은 (bot, by) 5초 내 재발생 무시 ──
const _evasionDedupe    = new Map();
const EVASION_DEDUPE_MS = 5_000;
const EVASION_GC_AGE    = 5 * 60_000;

// ── 이베이전 로그 완전 무시 목록 ──
const EVASION_IGN_BLACKLIST = ['iiPudin'];

function shouldRecordEvasion(owner, ign, by) {
  if (!by) return false;
  const k   = `${owner}|${ign}|${by}`;
  const now = Date.now();
  const prev = _evasionDedupe.get(k);
  if (prev && (now - prev) < EVASION_DEDUPE_MS) return false;
  _evasionDedupe.set(k, now);
  if (_evasionDedupe.size > 500) {
    for (const [kk, ts] of _evasionDedupe)
      if (now - ts > EVASION_GC_AGE) _evasionDedupe.delete(kk);
  }
  return true;
}

function svrCalcMesoHr(owner, ign, meso) {
  const key = owner + "|" + ign;
  const now = Date.now();
  if (!_svrHistory[key]) _svrHistory[key] = { samples: [], lastMeso: null, lastTs: null, lastValidTs: 0, pendDir: 0, pendCnt: 0 };
  const h = _svrHistory[key];
  if (h.lastMeso != null && h.lastTs != null) {
    const dt_ms = now - h.lastTs;
    const diff  = meso - h.lastMeso;
    if (dt_ms > SVR_MAX_DT_MS) {
      h.samples = []; h.pendDir = 0; h.pendCnt = 0;
    } else if (dt_ms > 0 && diff > 0 && diff < SVR_MAX_DIFF) {
      const rate = Math.floor((diff / dt_ms) * 3_600_000);
      // ★ 레짐 변화 감지: 현재 샘플이 윈도우 평균 대비 60%+ 급변하면(FZ 토글 의심)
      //   같은 방향 2연속 시 윈도우를 리셋 → 옛 구간 섞이지 않고 새 rate로 즉시 수렴
      if (h.samples.length >= 2) {
        const avg = h.samples.reduce((a, b) => a + b, 0) / h.samples.length;
        const ratio = rate / Math.max(avg, 1);
        if (ratio >= 1.6 || ratio <= 0.6) {
          const dir = ratio >= 1 ? 1 : -1;
          if (h.pendDir === dir) h.pendCnt++; else { h.pendDir = dir; h.pendCnt = 1; }
          if (h.pendCnt >= 2) { h.samples = []; h.pendDir = 0; h.pendCnt = 0; }
        } else { h.pendDir = 0; h.pendCnt = 0; }
      }
      h.samples.push(rate);
      while (h.samples.length > SVR_WINDOW) h.samples.shift();
      h.lastValidTs = now;
    }
  }
  h.lastMeso = meso;
  h.lastTs   = now;
  // Staleness: 유효 샘플이 2분 이상 없으면 윈도우 클리어
  if (h.lastValidTs && (now - h.lastValidTs) > SVR_STALE_MS) {
    h.samples = []; h.pendDir = 0; h.pendCnt = 0;
  }
  if (h.samples.length < 2) return null;
  return Math.floor(h.samples.reduce((a, b) => a + b, 0) / h.samples.length);
}

function ensureManualReleasedTable() {
  db.run(`CREATE TABLE IF NOT EXISTS manual_released (
    owner TEXT NOT NULL, ign TEXT NOT NULL, PRIMARY KEY (owner, ign)
  )`);
}

// ══════════════════════════════════════════════════
// POST /api/bot-heartbeat/client
// ══════════════════════════════════════════════════
router.post("/", (req, res) => {
  const {
    ign, owner, token, level, world_id, channel, map_id, client_tick,
    meso, meso_hr: lua_meso_hr, items, buff_count, job,
    evasion_by,
  } = req.body;

  if (!ign || !owner || !token)
    return res.status(400).json({ error: "Missing: ign, owner, token" });

  const tokRow = db.get("SELECT token FROM tokens  WHERE owner=?", [owner])
              || db.get("SELECT token FROM clients WHERE owner=?", [owner]);
  if (!tokRow)                return res.status(401).json({ error: "Unknown owner" });
  if (tokRow.token !== token) return res.status(401).json({ error: "Invalid token" });

  ensureManualReleasedTable();

  const now     = Date.now();
  const hasMeso = meso !== undefined && meso !== null;
  const mesoNum = hasMeso ? Number(meso) : null;
  const luaHr   = Number(lua_meso_hr) || 0;
  const buffCnt = (buff_count !== undefined && buff_count !== null) ? Number(buff_count) : null;

  // ── evasion 유효성 사전 판단 (채널변경 감지에서 인라인 처리) ──
  const isBlacklistedEvasion =
    EVASION_IGN_BLACKLIST.some(bl => ign === bl) ||
    EVASION_IGN_BLACKLIST.some(bl =>
      typeof evasion_by === 'string' &&
      evasion_by.split(',').map(s => s.trim()).includes(bl)
    );
  const isValidEvasion = !!(evasion_by && !isBlacklistedEvasion && shouldRecordEvasion(owner, ign, evasion_by));

  // ─────────────────────────────────────────────
  // 1) HEARTBEATS 테이블
  // ─────────────────────────────────────────────
  const prevHb = db.get("SELECT channel, map_id FROM heartbeats WHERE owner=? AND ign=?", [owner, ign]);
  db.run(
    `INSERT INTO heartbeats (owner,ign,level,world_id,channel,map_id,client_tick,last_seen)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(owner,ign) DO UPDATE SET
       level=excluded.level, world_id=excluded.world_id, channel=excluded.channel,
       map_id=excluded.map_id, client_tick=excluded.client_tick, last_seen=excluded.last_seen`,
    [owner, ign, level||0, world_id??null, channel??null, map_id??null, client_tick??null, now]
  );

  // ─────────────────────────────────────────────
  // 2) Change Log — channel / map 변경 감지
  // ─────────────────────────────────────────────
  if (prevHb) {
    const oldCh  = prevHb.channel ?? null;
    const oldMap = prevHb.map_id  ?? null;
    const newCh  = channel ?? null;
    const newMap = map_id  ?? null;

    if (String(oldCh) !== String(newCh)) {
      if (isValidEvasion) {
        // ★ cced_by_evasion: evasion_by 있음 → 즉시 기록 (pending 없음)
        //   new_val 포맷: "새채널||evasion_by" (|| 구분자)
        db.run(
          "INSERT INTO bot_change_log (ts,owner,ign,field,old_val,new_val) VALUES (?,?,?,?,?,?)",
          [now, owner, ign, "cced_by_evasion", String(oldCh), `${String(newCh)}||${evasion_by}`]
        );
        console.log(`[CCED_BY_EVASION] ${ign}: CH${oldCh}→CH${newCh} by ${evasion_by}`);
      } else {
        // ★ cc: 단순 채널변경 (crash / auto / 수동)
        db.run(
          "INSERT INTO bot_change_log (ts,owner,ign,field,old_val,new_val) VALUES (?,?,?,?,?,?)",
          [now, owner, ign, "cc", String(oldCh), String(newCh)]
        );
      }
    }

    if (String(oldMap) !== String(newMap)) {
      // ★ map: 맵 변경
      db.run(
        "INSERT INTO bot_change_log (ts,owner,ign,field,old_val,new_val) VALUES (?,?,?,?,?,?)",
        [now, owner, ign, "map", String(oldMap), String(newMap)]
      );
    }
  }

  // ─────────────────────────────────────────────
  // 3) Lv.219 이하 자동 FORCED 처리
  // ─────────────────────────────────────────────
  const lvNum = Number(level) || 0;
  if (lvNum > 0 && lvNum <= AUTO_FORCE_LEVEL) {
    const alreadyForced    = db.get("SELECT 1 FROM forced_offline  WHERE owner=? AND ign=?", [owner, ign]);
    const manuallyReleased = db.get("SELECT 1 FROM manual_released WHERE owner=? AND ign=?", [owner, ign]);
    if (!alreadyForced && !manuallyReleased)
      db.run("INSERT OR IGNORE INTO forced_offline (owner,ign,forced_at) VALUES (?,?,?)", [owner, ign, now]);
  }

  // ─────────────────────────────────────────────
  // 4) PRIVATE_DATA + MESO_HISTORY
  // ─────────────────────────────────────────────
  if (hasMeso) {
    const prevPd = db.get("SELECT buff_count FROM private_data WHERE owner=? AND ign=?", [owner, ign]);

    // ★ death: buff_count가 11로 변경된 경우만 기록
    if (buffCnt === 11 && prevPd && prevPd.buff_count !== 11) {
      db.run(
        "INSERT INTO bot_change_log (ts,owner,ign,field,old_val,new_val) VALUES (?,?,?,?,?,?)",
        [now, owner, ign, "death", String(prevPd.buff_count ?? 0), "11"]
      );
      console.log(`[DEATH] ${ign}: buff_count → 11`);
    }

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
        : svrHr;   // ★ min() → svrHr: 실제 meso 증가분 기반 실측값 우선 (상승 억제 제거)
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

    const last = db.get(
      "SELECT ts FROM meso_history WHERE owner=? AND ign=? ORDER BY ts DESC LIMIT 1",
      [owner, ign]
    );
    if (!last || (now - last.ts) >= HISTORY_INTERVAL)
      db.run("INSERT INTO meso_history (owner,ign,meso,meso_hr,ts) VALUES (?,?,?,?,?)",
        [owner, ign, mesoNum, verified_meso_hr, now]);

    let isForcedOffline = false;
    try {
      const row = db.get("SELECT 1 FROM forced_offline WHERE owner=? AND ign=?", [owner, ign]);
      isForcedOffline = !!row;
    } catch(e) {}
    checkMesoAlert(owner, ign, lvNum, verified_meso_hr || null, true, isForcedOffline);
  }

  return res.json({ ok: true, ts: now });
});

// ══════════════════════════════════════════════════
// DELETE /manual-release
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
  db.run("DELETE FROM forced_offline  WHERE owner=? AND ign=?", [owner, ign]);
  db.run("INSERT OR IGNORE INTO manual_released (owner,ign) VALUES (?,?)", [owner, ign]);
  return res.json({ ok: true, owner, ign, manuallyReleased: true });
});

// ══════════════════════════════════════════════════
// GET /api/bot-heartbeat/client (프렌지 봇이 읽음)
// ══════════════════════════════════════════════════
router.get("/", (req, res) => {
  const STALE = 120_000;
  const now   = Date.now();
  const rows  = db.all(
    "SELECT owner,ign,level,world_id,channel,map_id,last_seen FROM heartbeats ORDER BY owner,ign"
  );
  const forced = new Set(
    db.all("SELECT owner,ign FROM forced_offline").map(r => r.owner + "|" + r.ign)
  );
  return res.json(rows.map(r => ({
    ...r,
    online:  !forced.has(r.owner + "|" + r.ign) && (now - r.last_seen) < STALE,
    forced:  forced.has(r.owner + "|" + r.ign),
    ago_sec: Math.floor((now - r.last_seen) / 1000),
  })));
});

module.exports = router;
