const express = require("express");
const router  = express.Router();
const path    = require("path");
const fs      = require("fs");
const db      = require("../db");

// ════════════════════════════════════════════════════════════
// ★★★ 하드코딩 시드: Rudy 캐스팅 순서 1~15번 (변경 불가) ★★★
//   - 서버 시작 시 fz_list 테이블에 강제 동기화 (sort_order 1..15, is_pinned=1)
//   - Railway 재배포로 unified.db 가 날아가도 항상 복원됨
//   - 순서/삭제 변경 불가, 16번 이후는 자유롭게 추가/제거
// ════════════════════════════════════════════════════════════
const SEED_FZ_IGNS = [
  "911CHEBOL",     // 1
  "EXHYEONG",      // 2
  "EXKANNAo",      // 3
  "FENDYEONG",     // 4
  "perubianight", // 5
  "J2WCOFFEE",     // 6
  "peruCOFFEE",    // 7
  "SANAnDANA",     // 8
  "PaulGarrett",   // 9
  "LukeJohnsono",  // 10
  "EllenCraig",    // 11
  "KaylaRussell",  // 12
  "ChrlstopherV",  // 13
  "JenniferDcke",  // 14
  "DebraKlein",    // 15
];
const SEED_IGN_SET = new Set(SEED_FZ_IGNS);

// ── 테이블 초기화 + 시드 동기화 ──
function ensureTable() {
  db.run(`
    CREATE TABLE IF NOT EXISTS fz_list (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      ign        TEXT NOT NULL UNIQUE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      is_pinned  INTEGER NOT NULL DEFAULT 0
    )
  `);
  // 기존 DB에 is_pinned 컬럼 없으면 추가 (마이그레이션)
  try { db.run("ALTER TABLE fz_list ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0"); }
  catch(e) { /* 이미 존재 */ }
}
ensureTable();

// ── 시드 강제 동기화: 15명을 항상 sort_order 1~15에 고정 ──
function syncSeedList() {
  const now = Date.now();
  // 1) 기존 unpinned 봇들의 최소 sort_order 확보 (16부터 시작하도록)
  //    먼저 SEED IGN 들을 pinned 처리 (이미 존재하면 sort_order/is_pinned만 업데이트)
  SEED_FZ_IGNS.forEach((ign, idx) => {
    const pos = idx + 1;
    const existing = db.get("SELECT id FROM fz_list WHERE ign=?", [ign]);
    if (existing) {
      db.run("UPDATE fz_list SET sort_order=?, is_pinned=1 WHERE ign=?", [pos, ign]);
    } else {
      try {
        db.run(
          "INSERT INTO fz_list (ign, sort_order, created_at, is_pinned) VALUES (?,?,?,1)",
          [ign, pos, now]
        );
      } catch(e) { /* race condition 무시 */ }
    }
  });
  // 2) seed에 없는 봇 중 sort_order가 1~15 사이로 잘못된 경우 16+ 로 재배치
  const unpinned = db.all("SELECT id, ign, sort_order FROM fz_list WHERE is_pinned=0 ORDER BY sort_order ASC, id ASC");
  let nextOrder = 16;
  unpinned.forEach(r => {
    if (r.sort_order !== nextOrder) {
      db.run("UPDATE fz_list SET sort_order=? WHERE id=?", [nextOrder, r.id]);
    }
    nextOrder++;
  });
  console.log(`[FZ-SEED] synced ${SEED_FZ_IGNS.length} pinned bots + ${unpinned.length} user bots`);
}
syncSeedList();

// mapnames.json 위치 (server.js와 동일 경로 규칙)
const MAPNAMES_PATH = path.join(__dirname, "..", "public", "mapnames.json");
function loadMapNames() {
  try {
    if (fs.existsSync(MAPNAMES_PATH))
      return JSON.parse(fs.readFileSync(MAPNAMES_PATH, "utf8"));
  } catch(e) { console.error("[fz/mapnames] load error:", e.message); }
  return {};
}
function saveMapNames(obj) {
  try {
    fs.writeFileSync(MAPNAMES_PATH, JSON.stringify(obj, null, 2), "utf8");
  } catch(e) { console.error("[fz/mapnames] save error:", e.message); }
}

// GET /api/fz — 전체 목록 (순서대로)
router.get("/", (req, res) => {
  const rows = db.all("SELECT * FROM fz_list ORDER BY sort_order ASC, id ASC");
  res.json(rows);
});

// ════════════════════════════════════════════════════════════
// GET /api/fz/status — public (no auth)
// FZ 리스트에 있는 IGN들의 최소 상태만 반환 (online/channel/map_id/map_name)
// 인증 없이도 루디가 사용할 수 있도록 별도 엔드포인트로 분리
// ════════════════════════════════════════════════════════════
router.get("/status", (req, res) => {
  const fzRows = db.all("SELECT ign FROM fz_list");
  const fzIgns = fzRows.map(r => r.ign);
  if (!fzIgns.length) return res.json([]);

  const placeholders = fzIgns.map(() => "?").join(",");
  const now = Date.now();

  // heartbeats 테이블에서 채널/맵을, private_data에서 last_seen을 확인
  const hbRows = db.all(
    `SELECT ign, channel, map_id, last_seen FROM heartbeats WHERE ign IN (${placeholders})`,
    fzIgns
  );
  const pdRows = db.all(
    `SELECT ign, last_seen FROM private_data WHERE ign IN (${placeholders})`,
    fzIgns
  );

  // ign별로 합치기 — heartbeats 우선, 둘 중 더 최근의 last_seen 사용
  const byIgn = {};
  for (const r of hbRows) {
    byIgn[r.ign] = {
      ign:       r.ign,
      channel:   r.channel,
      map_id:    r.map_id,
      last_seen: r.last_seen || 0,
    };
  }
  for (const r of pdRows) {
    if (!byIgn[r.ign]) {
      byIgn[r.ign] = { ign: r.ign, channel: null, map_id: null, last_seen: r.last_seen || 0 };
    } else if ((r.last_seen || 0) > (byIgn[r.ign].last_seen || 0)) {
      byIgn[r.ign].last_seen = r.last_seen;
    }
  }

  // ── 최근 채널변경(=CC) 시점을 IGN별로 집계 (FZ 리스트 IGN에 한해) ──
  // field='channel' 또는 'cced_by_evasion' 둘 다 CC로 간주
  const ccRows = db.all(
    `SELECT ign, MAX(ts) AS last_cc_ts
       FROM bot_change_log
      WHERE ign IN (${placeholders})
        AND field IN ('channel','cced_by_evasion')
      GROUP BY ign`,
    fzIgns
  );
  const lastCcByIgn = {};
  for (const r of ccRows) lastCcByIgn[r.ign] = r.last_cc_ts || 0;

  const mapNames = loadMapNames();
  const ONLINE_THRESHOLD_MS = 120_000;

  const result = fzIgns.map(ign => {
    const r = byIgn[ign];
    const last_cc_ts = lastCcByIgn[ign] || null;
    if (!r) {
      return { ign, online: false, channel: null, map_id: null, map_name: null, ago_sec: null, last_cc_ts };
    }
    const ago = Math.floor((now - r.last_seen) / 1000);
    return {
      ign:        r.ign,
      online:     (now - r.last_seen) < ONLINE_THRESHOLD_MS,
      channel:    r.channel,
      map_id:     r.map_id,
      map_name:   r.map_id != null ? (mapNames[String(r.map_id)] || null) : null,
      ago_sec:    ago,
      last_cc_ts,
    };
  });

  res.json(result);
});

// POST /api/fz — IGN 추가 (unpinned only, sort_order는 항상 16+)
router.post("/", (req, res) => {
  const { ign } = req.body;
  if (!ign) return res.status(400).json({ error: "ign required" });
  const trimmed = ign.trim();
  if (SEED_IGN_SET.has(trimmed)) {
    return res.status(409).json({ error: "Pinned bot already exists at fixed position" });
  }

  // 현재 최대 sort_order + 1 (시드 15명이 있으므로 항상 16+)
  const maxRow = db.get("SELECT MAX(sort_order) as m FROM fz_list");
  const nextOrder = (maxRow && maxRow.m != null) ? maxRow.m + 1 : 16;

  try {
    db.run(
      "INSERT INTO fz_list (ign, sort_order, created_at, is_pinned) VALUES (?,?,?,0)",
      [trimmed, nextOrder, Date.now()]
    );
    res.json({ ok: true });
  } catch(e) {
    res.status(409).json({ error: "IGN already exists" });
  }
});

// DELETE /api/fz/:ign — IGN 삭제 (★ pinned 보호)
router.delete("/:ign", (req, res) => {
  const ign = req.params.ign;
  if (SEED_IGN_SET.has(ign)) {
    return res.status(403).json({ error: "Cannot delete a pinned (seed) bot" });
  }
  db.run("DELETE FROM fz_list WHERE ign=? AND is_pinned=0", [ign]);
  // unpinned 만 재정렬 (16부터)
  const rows = db.all("SELECT id FROM fz_list WHERE is_pinned=0 ORDER BY sort_order ASC, id ASC");
  rows.forEach((r, i) => {
    db.run("UPDATE fz_list SET sort_order=? WHERE id=?", [16 + i, r.id]);
  });
  res.json({ ok: true });
});

// PUT /api/fz/reorder — 순서 일괄 업데이트 (★ pinned 1~15는 강제 유지)
// body: { order: ["IGN1","IGN2",...] }
router.put("/reorder", (req, res) => {
  const { order } = req.body;
  if (!Array.isArray(order)) return res.status(400).json({ error: "order array required" });

  // 입력 order에서 pinned 봇은 무시하고 unpinned 만 16+ 부터 순서대로 배치
  const unpinnedOrder = order.filter(ign => !SEED_IGN_SET.has(ign));
  unpinnedOrder.forEach((ign, i) => {
    db.run("UPDATE fz_list SET sort_order=? WHERE ign=? AND is_pinned=0", [16 + i, ign]);
  });
  // pinned 는 항상 1~15 위치 강제
  SEED_FZ_IGNS.forEach((ign, i) => {
    db.run("UPDATE fz_list SET sort_order=?, is_pinned=1 WHERE ign=?", [i + 1, ign]);
  });
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════
// POST /api/fz/mapname — public (no auth)
// FZ 탭에서 맵이름을 수정할 수 있도록 인증 없이 허용
// body: { map_id, map_name }
// ════════════════════════════════════════════════════════════
router.post("/mapname", (req, res) => {
  const { map_id, map_name } = req.body;
  if (!map_id || !map_name) {
    return res.status(400).json({ error: "map_id and map_name required" });
  }
  const obj = loadMapNames();
  obj[String(map_id)] = String(map_name).slice(0, 200);
  saveMapNames(obj);
  res.json({ ok: true, map_id: String(map_id), map_name: obj[String(map_id)] });
});

module.exports = router;
