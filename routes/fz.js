const express = require("express");
const router  = express.Router();
const path    = require("path");
const fs      = require("fs");
const crypto  = require("crypto");
const db      = require("../db");

// ── 테이블 보강 (db.js에서 이미 생성하지만 단독 동작 안전망) ──
db.run(`
  CREATE TABLE IF NOT EXISTS fz_list (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ign        TEXT NOT NULL UNIQUE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )
`);
try { db.run("ALTER TABLE fz_list ADD COLUMN grp TEXT NOT NULL DEFAULT 'rudy'"); } catch(e) {}

// ── 그룹 해석 / 키 검증 ──────────────────────────────────────────
// grp 결정: query.grp → body.grp → 기본 'rudy'
function resolveGrp(req) {
  const g = (req.query.grp || req.body?.grp || "rudy").toString().trim().toLowerCase();
  return g || "rudy";
}
// 그룹 메타 조회
function getGroup(grp) {
  return db.get("SELECT * FROM fz_groups WHERE grp=?", [grp]);
}
// 그룹 접근 허용 여부:
//  - is_public=1 (rudy) → 키 없이 OK
//  - 그 외(gabi 등)   → query.key 또는 헤더 x-fz-key 가 그룹 api_key 와 일치해야 OK
function checkGroupAccess(req, grp) {
  const meta = getGroup(grp);
  if (!meta) return { ok: false, code: 404, error: "unknown group" };
  if (meta.is_public) return { ok: true, meta };
  const key = (req.query.key || req.headers["x-fz-key"] || "").toString();
  if (key && meta.api_key && key === meta.api_key) return { ok: true, meta };
  return { ok: false, code: 401, error: "invalid or missing fz key" };
}

// mapnames.json
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

// ── GET /api/fz — 그룹별 목록 ───────────────────────────────────
// rudy: 공개 / gabi: ?key= 또는 x-fz-key 필요
router.get("/", (req, res) => {
  const grp = resolveGrp(req);
  const acc = checkGroupAccess(req, grp);
  if (!acc.ok) return res.status(acc.code).json({ error: acc.error });
  const rows = db.all(
    "SELECT * FROM fz_list WHERE grp=? ORDER BY sort_order ASC, id ASC",
    [grp]
  );
  res.json(rows);
});

// ── GET /api/fz/status — 그룹별 온라인 상태 ─────────────────────
router.get("/status", (req, res) => {
  const grp = resolveGrp(req);
  const acc = checkGroupAccess(req, grp);
  if (!acc.ok) return res.status(acc.code).json({ error: acc.error });

  const fzRows = db.all("SELECT ign FROM fz_list WHERE grp=?", [grp]);
  const fzIgns = fzRows.map(r => r.ign);
  if (!fzIgns.length) return res.json([]);

  const placeholders = fzIgns.map(() => "?").join(",");
  const now = Date.now();

  const hbRows = db.all(
    `SELECT ign, channel, map_id, last_seen FROM heartbeats WHERE ign IN (${placeholders})`,
    fzIgns
  );
  const pdRows = db.all(
    `SELECT ign, last_seen FROM private_data WHERE ign IN (${placeholders})`,
    fzIgns
  );

  const byIgn = {};
  for (const r of hbRows) {
    byIgn[r.ign] = { ign: r.ign, channel: r.channel, map_id: r.map_id, last_seen: r.last_seen || 0 };
  }
  for (const r of pdRows) {
    if (!byIgn[r.ign]) {
      byIgn[r.ign] = { ign: r.ign, channel: null, map_id: null, last_seen: r.last_seen || 0 };
    } else if ((r.last_seen || 0) > (byIgn[r.ign].last_seen || 0)) {
      byIgn[r.ign].last_seen = r.last_seen;
    }
  }

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
      ign,
      online:   (now - r.last_seen) < ONLINE_THRESHOLD_MS,
      channel:  r.channel,
      map_id:   r.map_id,
      map_name: r.map_id != null ? (mapNames[String(r.map_id)] || null) : null,
      ago_sec:  ago,
      last_cc_ts,
    };
  });

  res.json(result);
});

// ── GET /api/fz/groups — 그룹/키 메타 (메인 대시보드 표시용) ──────
// 주의: 키 노출 엔드포인트이므로 server.js 에서 requireAuth 로 감싸 사용
router.get("/groups", (req, res) => {
  const rows = db.all("SELECT grp, label, api_key, is_public, max_slots FROM fz_groups ORDER BY grp");
  const out = rows.map(g => ({
    ...g,
    count: db.get("SELECT COUNT(*) AS n FROM fz_list WHERE grp=?", [g.grp]).n,
  }));
  res.json(out);
});

// ── POST /api/fz/groups/:grp/rotate — gabi 키 재발급 (auth 권장) ──
router.post("/groups/:grp/rotate", (req, res) => {
  const grp = req.params.grp.toLowerCase();
  const meta = getGroup(grp);
  if (!meta) return res.status(404).json({ error: "unknown group" });
  if (meta.is_public) return res.status(400).json({ error: "public group has no key" });
  const key = crypto.randomBytes(24).toString("hex");
  db.run("UPDATE fz_groups SET api_key=? WHERE grp=?", [key, grp]);
  res.json({ ok: true, grp, api_key: key });
});

// ── POST /api/fz — IGN 추가 (그룹별, max_slots 캡 적용) ──────────
router.post("/", (req, res) => {
  const { ign } = req.body;
  const grp = resolveGrp(req);
  if (!ign) return res.status(400).json({ error: "ign required" });
  const meta = getGroup(grp);
  if (!meta) return res.status(404).json({ error: "unknown group" });

  const trimmed = ign.trim();

  // 슬롯 캡 검사 (rudy=10, gabi=10)
  const cur = db.get("SELECT COUNT(*) AS n FROM fz_list WHERE grp=?", [grp]).n;
  if (meta.max_slots > 0 && cur >= meta.max_slots) {
    return res.status(409).json({ error: `${meta.label || grp} 그룹은 최대 ${meta.max_slots}개까지입니다.` });
  }

  const maxRow = db.get("SELECT MAX(sort_order) as m FROM fz_list WHERE grp=?", [grp]);
  const nextOrder = (maxRow && maxRow.m != null) ? maxRow.m + 1 : 1;

  try {
    db.run(
      "INSERT INTO fz_list (ign, sort_order, created_at, grp) VALUES (?,?,?,?)",
      [trimmed, nextOrder, Date.now(), grp]
    );
    res.json({ ok: true });
  } catch(e) {
    res.status(409).json({ error: "IGN already exists" });
  }
});

// ── DELETE /api/fz/:ign — 삭제 후 동일 그룹 재정렬 ───────────────
router.delete("/:ign", (req, res) => {
  const ign = req.params.ign;
  const row = db.get("SELECT grp FROM fz_list WHERE ign=?", [ign]);
  db.run("DELETE FROM fz_list WHERE ign=?", [ign]);
  if (row) {
    const rows = db.all("SELECT id FROM fz_list WHERE grp=? ORDER BY sort_order ASC, id ASC", [row.grp]);
    rows.forEach((r, i) => db.run("UPDATE fz_list SET sort_order=? WHERE id=?", [i + 1, r.id]));
  }
  res.json({ ok: true });
});

// ── PUT /api/fz/reorder — 그룹 내 순서 일괄 업데이트 ─────────────
// body: { order: ["IGN1","IGN2",...], grp?: "rudy"|"gabi" }
router.put("/reorder", (req, res) => {
  const { order } = req.body;
  if (!Array.isArray(order)) return res.status(400).json({ error: "order array required" });
  order.forEach((ign, i) => {
    db.run("UPDATE fz_list SET sort_order=? WHERE ign=?", [i + 1, ign]);
  });
  res.json({ ok: true });
});

// ── POST /api/fz/mapname — 맵이름 수정 (공개) ───────────────────
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
