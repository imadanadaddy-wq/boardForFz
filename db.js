const path = require("path");
const fs   = require("fs");

// Railway Volume을 사용하면 DATABASE_PATH 환경변수로 경로 지정
// 예) Railway > Variables: DATABASE_PATH=/data/unified.db
// Volume 없으면 로컬 파일로 fallback (재배포 시 초기화됨 — 주의)
const DB_PATH = process.env.DATABASE_PATH
  ? process.env.DATABASE_PATH
  : path.join(__dirname, "unified.db");

// DB 디렉터리가 없으면 생성
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const Database = require("better-sqlite3");
const db = new Database(DB_PATH);

// WAL 모드 — 동시 읽기 성능 향상
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS private_data (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    owner     TEXT NOT NULL,
    ign       TEXT NOT NULL,
    level     INTEGER DEFAULT 0,
    meso      INTEGER DEFAULT 0,
    meso_hr   INTEGER DEFAULT 0,
    items       TEXT DEFAULT '[]',
    ts          INTEGER,
    last_seen   INTEGER NOT NULL,
    buff_count  INTEGER DEFAULT NULL,
    UNIQUE(owner, ign)
  );
  CREATE TABLE IF NOT EXISTS tokens (
    owner TEXT NOT NULL UNIQUE,
    token TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS clients (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    owner TEXT NOT NULL UNIQUE,
    token TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS heartbeats (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    owner       TEXT NOT NULL,
    ign         TEXT NOT NULL,
    level       INTEGER DEFAULT 0,
    world_id    INTEGER,
    channel     INTEGER,
    map_id      INTEGER,
    client_tick INTEGER,
    last_seen   INTEGER NOT NULL,
    UNIQUE(owner, ign)
  );
  CREATE TABLE IF NOT EXISTS map_names (
    grp      TEXT NOT NULL DEFAULT 'rudy',
    map_id   TEXT NOT NULL,
    map_name TEXT NOT NULL,
    PRIMARY KEY (grp, map_id)
  );
  CREATE TABLE IF NOT EXISTS seller_records (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    seller_name    TEXT NOT NULL,
    start_date     TEXT NOT NULL,
    end_date       TEXT NOT NULL,
    price_per_hour REAL NOT NULL,
    hours_worked   REAL DEFAULT 0,
    total_price    REAL DEFAULT 0,
    note           TEXT DEFAULT '',
    created_at     INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS bot_change_log (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    ts      INTEGER NOT NULL,
    owner   TEXT NOT NULL,
    ign     TEXT NOT NULL,
    field   TEXT NOT NULL,
    old_val TEXT,
    new_val TEXT
  );
  CREATE TABLE IF NOT EXISTS meso_history (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    owner   TEXT NOT NULL,
    ign     TEXT NOT NULL,
    meso    INTEGER NOT NULL,
    meso_hr INTEGER NOT NULL,
    ts      INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS forced_offline (
    owner     TEXT NOT NULL,
    ign       TEXT NOT NULL,
    forced_at INTEGER NOT NULL,
    PRIMARY KEY (owner, ign)
  );
  CREATE TABLE IF NOT EXISTS meso_alert_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    owner           TEXT NOT NULL,
    ign             TEXT NOT NULL,
    level           INTEGER,
    low_since       INTEGER NOT NULL,
    resolved_ts     INTEGER NOT NULL,
    resolved_reason TEXT NOT NULL,
    resolved_meso_hr INTEGER,
    alerted         INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS bot_pc_tags (
    ign        TEXT PRIMARY KEY,
    pc_tag     TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS pcs (
    pc_id            TEXT PRIMARY KEY,
    name             TEXT NOT NULL DEFAULT '',
    ip               TEXT NOT NULL DEFAULT '',
    first_seen       INTEGER NOT NULL,
    last_seen        INTEGER NOT NULL,
    last_screenshot  INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS active_bots (
    ign        TEXT PRIMARY KEY,
    marked_at  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS fz_list (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ign        TEXT NOT NULL UNIQUE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  -- ★ NEW: FZ 그룹(공급자) — rudy / gabi 등 리스트를 분리하고 그룹별 전용 API 키를 둔다
  CREATE TABLE IF NOT EXISTS fz_groups (
    grp        TEXT PRIMARY KEY,          -- 'rudy' | 'gabi' ...
    label      TEXT NOT NULL DEFAULT '',  -- 화면 표시용 이름
    api_key    TEXT,                      -- 그룹 전용 스코프 키 (rudy는 공개라 NULL 허용)
    is_public  INTEGER NOT NULL DEFAULT 0,-- 1이면 키 없이 조회 가능 (rudy=1)
    max_slots  INTEGER NOT NULL DEFAULT 0, -- 0=무제한
    created_at INTEGER NOT NULL
  );
  -- ★ NEW: 봇별 메획 설정 (관리자 참고 메모용 — FZ 판정 공식엔 안 씀)
  CREATE TABLE IF NOT EXISTS bot_meso_config (
    ign         TEXT PRIMARY KEY,
    has_ia      INTEGER NOT NULL DEFAULT 0,  -- 메획 어빌리티 보유 0/1
    gear_count  INTEGER NOT NULL DEFAULT 0,  -- 메획 장비 개수 0~6
    updated_at  INTEGER NOT NULL DEFAULT 0
  );
  -- ★ NEW: 맵별 컬러 (Rudy/Gabi가 맵에 색 지정 → 같은 맵 봇들 동일 배경)
  CREATE TABLE IF NOT EXISTS map_colors (
    map_name   TEXT PRIMARY KEY,           -- 정규화된 맵 라벨 (예: "Alley 3")
    color      TEXT NOT NULL,              -- 파스텔 hex (예: "#ffe0e0")
    updated_at INTEGER NOT NULL DEFAULT 0
  );
  -- ★ NEW: 프록시 관리
  CREATE TABLE IF NOT EXISTS proxies (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ip         TEXT NOT NULL,
    port       TEXT NOT NULL,
    pid        TEXT DEFAULT '',            -- proxy id (auth user)
    pw         TEXT DEFAULT '',            -- proxy pw
    exp_ts     INTEGER DEFAULT NULL,       -- 만료 시각 (epoch ms, NULL=무기한)
    memo       TEXT DEFAULT '',            -- 행별 메모
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT 0
  );
`);

// 마이그레이션 (기존 DB 호환)
const migrations = [
  "ALTER TABLE private_data ADD COLUMN buff_count INTEGER DEFAULT NULL",
  "ALTER TABLE fz_list ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0",
  // ★ NEW: 기존 fz_list 행은 전부 'rudy' 그룹으로 귀속
  "ALTER TABLE fz_list ADD COLUMN grp TEXT NOT NULL DEFAULT 'rudy'",
  // ★ NEW: FZ ON/OFF 자동 판정 결과 저장 (1=ON, 0=OFF, NULL=미판정)
  "ALTER TABLE private_data ADD COLUMN fz_on INTEGER DEFAULT NULL",
];
for (const sql of migrations) {
  try { db.exec(sql); } catch(e) { /* 이미 존재 */ }
}

// ★ NEW: FZ 그룹 시드 — rudy(공개), gabi(전용 키)
const crypto = require("crypto");
const now0 = Date.now();
db.prepare(
  `INSERT OR IGNORE INTO fz_groups (grp, label, api_key, is_public, max_slots, created_at)
   VALUES (?,?,?,?,?,?)`
).run("rudy", "Rudy", null, 1, 0, now0);
db.prepare(
  `INSERT OR IGNORE INTO fz_groups (grp, label, api_key, is_public, max_slots, created_at)
   VALUES (?,?,?,?,?,?)`
).run("gabi", "Gabi", crypto.randomBytes(24).toString("hex"), 0, 0, now0);
// 상한 해제: 기존 max_slots=10 → 0
db.prepare("UPDATE fz_groups SET max_slots=0 WHERE max_slots=10").run();
// gabi 키가 비어있으면(과거 데이터 보정) 새로 발급
{
  const g = db.prepare("SELECT api_key FROM fz_groups WHERE grp='gabi'").get();
  if (g && !g.api_key) {
    db.prepare("UPDATE fz_groups SET api_key=? WHERE grp='gabi'")
      .run(crypto.randomBytes(24).toString("hex"));
  }
}

// 기본 클라이언트 시드
const DEFAULT_CLIENTS = [
  { owner: "Hyeong",
    token: "b4e8a2f1c9d3705e6b2c4a8f1d5e9a7c3b6e2f4d8a0c5e1b9f3a7c2d6e4b8f0" },
];
for (const c of DEFAULT_CLIENTS) {
  db.prepare("INSERT OR IGNORE INTO tokens  (owner, token) VALUES (?,?)").run(c.owner, c.token);
  db.prepare("INSERT OR IGNORE INTO clients (owner, token) VALUES (?,?)").run(c.owner, c.token);
}

// ★ 맵이름 그룹화 마이그레이션 — 구 스키마(map_id PK, grp 없음) → (grp, map_id) 복합키
//   구 전역 라벨을 rudy/gabi 양쪽으로 복제(시작값 동일), 이후 그룹별로 독립 편집.
try {
  const cols = db.prepare("PRAGMA table_info(map_names)").all();
  const hasGrp = cols.some(c => c.name === "grp");
  if (!hasGrp) {
    db.exec(`
      ALTER TABLE map_names RENAME TO map_names_old;
      CREATE TABLE map_names (
        grp      TEXT NOT NULL DEFAULT 'rudy',
        map_id   TEXT NOT NULL,
        map_name TEXT NOT NULL,
        PRIMARY KEY (grp, map_id)
      );
      INSERT OR IGNORE INTO map_names (grp, map_id, map_name) SELECT 'rudy', map_id, map_name FROM map_names_old;
      INSERT OR IGNORE INTO map_names (grp, map_id, map_name) SELECT 'gabi', map_id, map_name FROM map_names_old;
      DROP TABLE map_names_old;
    `);
    console.log("[DB] map_names migrated → per-group (grp, map_id)");
  }
} catch (e) { console.error("[DB] map_names migration error:", e.message); }

// ★ 맵이름 시드 — 번들된 public/mapnames.json → SQLite map_names (rudy/gabi 각각, INSERT OR IGNORE)
//   Railway 재배포 시 DB가 초기화되므로 영구 라벨은 mapnames.json에 보관 → 시드.
//   런타임 편집은 map_names 테이블에 직접 반영(파일 쓰기 의존 제거 → 읽기전용 FS 이슈 해소).
try {
  const _fs   = require("fs");
  const _path = require("path");
  const seedPath = _path.join(__dirname, "public", "mapnames.json");
  if (_fs.existsSync(seedPath)) {
    const seed = JSON.parse(_fs.readFileSync(seedPath, "utf8"));
    const ins  = db.prepare("INSERT OR IGNORE INTO map_names (grp, map_id, map_name) VALUES (?,?,?)");
    const tx   = db.transaction(obj => {
      for (const [id, name] of Object.entries(obj)) {
        ins.run("rudy", String(id), String(name));
        ins.run("gabi", String(id), String(name));
      }
    });
    tx(seed);
    console.log(`[DB] map_names seeded (${Object.keys(seed).length} labels × rudy/gabi)`);
  }
} catch (e) { console.error("[DB] map_names seed error:", e.message); }

console.log(`[DB] using ${DB_PATH}`);

// sql.js 스타일 호환 래퍼
function run(sql, params=[])  { return db.prepare(sql).run(...params); }
function get(sql, params=[])  { return db.prepare(sql).get(...params) || null; }
function all(sql, params=[])  { return db.prepare(sql).all(...params); }
function persist() { /* better-sqlite3는 자동으로 파일에 씀 — noop */ }
async function getDb() { return db; }  // 기존 코드 호환용

module.exports = { getDb, run, get, all, persist };
