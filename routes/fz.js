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

// ── 맵이름: SQLite map_names 테이블, 그룹별 분리 (grp, map_id) ──
//   rudy 탭 편집 → rudy 라벨, gabi 탭 편집 → gabi 라벨로 독립 저장.
function loadMapNames(grp) {
  const out = {};
  try {
    const rows = db.all("SELECT map_id, map_name FROM map_names WHERE grp=?", [grp || "rudy"]);
    for (const r of rows) out[String(r.map_id)] = r.map_name;
  } catch (e) { console.error("[fz/mapnames] load error:", e.message); }
  return out;
}
// 단일 라벨 upsert (그룹별)
function setMapName(grp, mapId, name) {
  db.run(
    `INSERT INTO map_names (grp, map_id, map_name) VALUES (?,?,?)
     ON CONFLICT(grp, map_id) DO UPDATE SET map_name=excluded.map_name`,
    [grp || "rudy", String(mapId), String(name).slice(0, 200)]
  );
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
    `SELECT ign, last_seen, fz_on FROM private_data WHERE ign IN (${placeholders})`,
    fzIgns
  );

  const byIgn = {};
  const fzOnByIgn = {};
  // ★ 같은 ign 이 owner별 복수 행을 가질 수 있음(재진입/PC 이동 시 옛 owner 행이 stale로 잔존).
  //   ign 기준 조인이므로 last_seen 이 가장 최신인 행만 채택 → stale 데이터로 인한 오프라인/옛맵 오표시 방지.
  for (const r of hbRows) {
    const ex = byIgn[r.ign];
    if (!ex || (r.last_seen || 0) > (ex.last_seen || 0)) {
      byIgn[r.ign] = { ign: r.ign, channel: r.channel, map_id: r.map_id, last_seen: r.last_seen || 0 };
    }
  }
  // private_data 도 ign별 최신만 반영
  const pdLatest = {};
  for (const r of pdRows) {
    const ex = pdLatest[r.ign];
    if (!ex || (r.last_seen || 0) > (ex.last_seen || 0)) pdLatest[r.ign] = r;
  }
  for (const ign in pdLatest) {
    const r = pdLatest[ign];
    fzOnByIgn[ign] = (r.fz_on === 1 ? true : (r.fz_on === 0 ? false : null));
    if (!byIgn[ign]) {
      byIgn[ign] = { ign, channel: null, map_id: null, last_seen: r.last_seen || 0 };
    } else if ((r.last_seen || 0) > (byIgn[ign].last_seen || 0)) {
      byIgn[ign].last_seen = r.last_seen;
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

  const mapNames = loadMapNames(grp);
  const ONLINE_THRESHOLD_MS = 120_000;

  const result = fzIgns.map(ign => {
    const r = byIgn[ign];
    const last_cc_ts = lastCcByIgn[ign] || null;
    const fz_on = (ign in fzOnByIgn) ? fzOnByIgn[ign] : null;
    if (!r) {
      return { ign, online: false, channel: null, map_id: null, map_name: null, ago_sec: null, last_cc_ts, fz_on };
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
      fz_on,
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

// ── POST /api/fz/mapname — 맵이름 수정 (공개, 그룹별) ───────────
//   grp: query.grp | body.grp (기본 rudy). server.js 가드에서 공개 예외 처리됨.
router.post("/mapname", (req, res) => {
  const { map_id, map_name } = req.body;
  if (!map_id || !map_name) {
    return res.status(400).json({ error: "map_id and map_name required" });
  }
  const grp = resolveGrp(req);
  setMapName(grp, map_id, map_name);
  res.json({ ok: true, grp, map_id: String(map_id), map_name: String(map_name).slice(0, 200) });
});

// ── GET /api/fz/mapnames — 그룹별 맵이름 전체 (공개) ────────────
router.get("/mapnames", (req, res) => {
  res.json(loadMapNames(resolveGrp(req)));
});

// ── GET /api/fz/health — 그룹 테이블 상태 진단 (공개) ──────────
router.get("/health", (req, res) => {
  try {
    const groups = db.all("SELECT grp, is_public, max_slots FROM fz_groups");
    const counts = db.all("SELECT grp, COUNT(*) AS n FROM fz_list GROUP BY grp");
    res.json({ ok: true, groups, counts });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── GET /api/fz/all — 전체 FZ 목록 (그룹 불문, 관리자용) ─────────
// server.js 에서 requireAuth 로 보호
router.get("/all", (req, res) => {
  const rows = db.all("SELECT * FROM fz_list ORDER BY grp, sort_order ASC, id ASC");
  res.json(rows);
});

// ── PUT /api/fz/:ign/assign — 봇 그룹 배정/해제 ─────────────────
// grp: 'rudy' | 'gabi' | 'none' (none이면 fz_list에서 삭제)
router.put("/:ign/assign", (req, res) => {
  const ign = req.params.ign;
  const grp = (req.body.grp || "").trim().toLowerCase();

  // 'none' = 해제
  if (grp === "none" || grp === "") {
    db.run("DELETE FROM fz_list WHERE ign=?", [ign]);
    return res.json({ ok: true, ign, grp: "none" });
  }

  const meta = getGroup(grp);
  if (!meta) return res.status(404).json({ error: "unknown group" });

  // 슬롯 캡 — 이미 같은 그룹이면 카운트 제외
  const existing = db.get("SELECT grp FROM fz_list WHERE ign=?", [ign]);
  if (!(existing && existing.grp === grp)) {
    const cur = db.get("SELECT COUNT(*) AS n FROM fz_list WHERE grp=?", [grp]).n;
    if (meta.max_slots > 0 && cur >= meta.max_slots) {
      return res.status(409).json({ error: `${meta.label || grp} max ${meta.max_slots}` });
    }
  }

  const maxRow = db.get("SELECT MAX(sort_order) as m FROM fz_list WHERE grp=?", [grp]);
  const nextOrder = (maxRow && maxRow.m != null) ? maxRow.m + 1 : 1;

  if (existing) {
    db.run("UPDATE fz_list SET grp=?, sort_order=? WHERE ign=?", [grp, nextOrder, ign]);
  } else {
    try {
      db.run("INSERT INTO fz_list (ign, sort_order, created_at, grp) VALUES (?,?,?,?)",
        [ign, nextOrder, Date.now(), grp]);
    } catch(e) {
      return res.status(409).json({ error: "IGN conflict" });
    }
  }
  res.json({ ok: true, ign, grp });
});

// ── GET /api/fz/meso-config — 전체 봇 메획 설정 (관리자용) ──────
// server.js 에서 requireAuth 로 보호
router.get("/meso-config", (req, res) => {
  const rows = db.all("SELECT ign, has_ia, gear_count FROM bot_meso_config");
  res.json(rows);
});

// ── PUT /api/fz/meso-config/:ign — IA/Gear 저장 ────────────────
router.put("/meso-config/:ign", (req, res) => {
  const ign = req.params.ign;
  const hasIa = req.body.has_ia ? 1 : 0;
  let gear = parseInt(req.body.gear_count, 10);
  if (isNaN(gear)) gear = 0;
  gear = Math.max(0, Math.min(6, gear));   // 0~6 클램프
  db.run(
    `INSERT INTO bot_meso_config (ign, has_ia, gear_count, updated_at)
     VALUES (?,?,?,?)
     ON CONFLICT(ign) DO UPDATE SET has_ia=excluded.has_ia, gear_count=excluded.gear_count, updated_at=excluded.updated_at`,
    [ign, hasIa, gear, Date.now()]
  );
  res.json({ ok: true, ign, has_ia: hasIa, gear_count: gear });
});

// ── GET /api/fz/map-colors — 맵 컬러 전체 (공개) ───────────────
router.get("/map-colors", (req, res) => {
  const rows = db.all("SELECT map_name, color FROM map_colors");
  const out = {};
  for (const r of rows) out[r.map_name] = r.color;
  res.json(out);
});

// ── PUT /api/fz/map-colors — 맵 컬러 지정/해제 (공개, 저위험) ────
// body: { map_name, color }  color가 빈값/null이면 해제
router.put("/map-colors", (req, res) => {
  const mapName = String(req.body.map_name || "").trim();
  const color   = req.body.color ? String(req.body.color).trim() : "";
  if (!mapName) return res.status(400).json({ error: "map_name required" });
  // hex 화이트리스트 검증 (#rgb / #rrggbb 만 허용)
  if (color && !/^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(color)) {
    return res.status(400).json({ error: "invalid color" });
  }
  if (color) {
    db.run(
      `INSERT INTO map_colors (map_name, color, updated_at) VALUES (?,?,?)
       ON CONFLICT(map_name) DO UPDATE SET color=excluded.color, updated_at=excluded.updated_at`,
      [mapName, color, Date.now()]
    );
  } else {
    db.run("DELETE FROM map_colors WHERE map_name=?", [mapName]);
  }
  res.json({ ok: true, map_name: mapName, color: color || null });
});

module.exports = router;
