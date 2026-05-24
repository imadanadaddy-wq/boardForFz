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
    map_id   TEXT PRIMARY KEY,
    map_name TEXT NOT NULL
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
`);

// 마이그레이션 (기존 DB 호환)
const migrations = [
  "ALTER TABLE private_data ADD COLUMN buff_count INTEGER DEFAULT NULL",
  "ALTER TABLE fz_list ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0",
];
for (const sql of migrations) {
  try { db.exec(sql); } catch(e) { /* 이미 존재 */ }
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

console.log(`[DB] using ${DB_PATH}`);

// sql.js 스타일 호환 래퍼
function run(sql, params=[])  { return db.prepare(sql).run(...params); }
function get(sql, params=[])  { return db.prepare(sql).get(...params) || null; }
function all(sql, params=[])  { return db.prepare(sql).all(...params); }
function persist() { /* better-sqlite3는 자동으로 파일에 씀 — noop */ }
async function getDb() { return db; }  // 기존 코드 호환용

module.exports = { getDb, run, get, all, persist };
