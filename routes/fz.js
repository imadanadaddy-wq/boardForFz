const express = require("express");
const router  = express.Router();
const path    = require("path");
const fs      = require("fs");
const db      = require("../db");

// ── 테이블 초기화 ──
function ensureTable() {
  db.run(`
    CREATE TABLE IF NOT EXISTS fz_list (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      ign        TEXT NOT NULL UNIQUE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )
  `);
}
ensureTable();

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

  const mapNames = loadMapNames();
  const ONLINE_THRESHOLD_MS = 120_000;

  const result = fzIgns.map(ign => {
    const r = byIgn[ign];
    if (!r) {
      return { ign, online: false, channel: null, map_id: null, map_name: null, ago_sec: null };
    }
    const ago = Math.floor((now - r.last_seen) / 1000);
    return {
      ign:       r.ign,
      online:    (now - r.last_seen) < ONLINE_THRESHOLD_MS,
      channel:   r.channel,
      map_id:    r.map_id,
      map_name:  r.map_id != null ? (mapNames[String(r.map_id)] || null) : null,
      ago_sec:   ago,
    };
  });

  res.json(result);
});

// POST /api/fz — IGN 추가
router.post("/", (req, res) => {
  const { ign } = req.body;
  if (!ign) return res.status(400).json({ error: "ign required" });

  // 현재 최대 sort_order + 1
  const maxRow = db.get("SELECT MAX(sort_order) as m FROM fz_list");
  const nextOrder = (maxRow && maxRow.m != null) ? maxRow.m + 1 : 1;

  try {
    db.run(
      "INSERT INTO fz_list (ign, sort_order, created_at) VALUES (?,?,?)",
      [ign.trim(), nextOrder, Date.now()]
    );
    res.json({ ok: true });
  } catch(e) {
    res.status(409).json({ error: "IGN already exists" });
  }
});

// DELETE /api/fz/:ign — IGN 삭제
router.delete("/:ign", (req, res) => {
  db.run("DELETE FROM fz_list WHERE ign=?", [req.params.ign]);
  // 삭제 후 sort_order 재정렬
  const rows = db.all("SELECT id FROM fz_list ORDER BY sort_order ASC, id ASC");
  rows.forEach((r, i) => {
    db.run("UPDATE fz_list SET sort_order=? WHERE id=?", [i + 1, r.id]);
  });
  res.json({ ok: true });
});

// PUT /api/fz/reorder — 순서 일괄 업데이트
// body: { order: ["IGN1","IGN2",...] }
router.put("/reorder", (req, res) => {
  const { order } = req.body;
  if (!Array.isArray(order)) return res.status(400).json({ error: "order array required" });

  order.forEach((ign, i) => {
    db.run("UPDATE fz_list SET sort_order=? WHERE ign=?", [i + 1, ign]);
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
