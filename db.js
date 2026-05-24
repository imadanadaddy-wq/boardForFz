const path = require("path");
const fs   = require("fs");
const initSqlJs = require("sql.js");
const DB_PATH = path.join(__dirname, "unified.db");
let db = null;
async function getDb() {
  if (db) return db;
  const SQL = await initSqlJs();
  db = fs.existsSync(DB_PATH)
    ? new SQL.Database(fs.readFileSync(DB_PATH))
    : new SQL.Database();
  db.run(`
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
      pc_id            TEXT PRIMARY KEY,           -- Electron이 생성/저장하는 UUID (영구 식별자)
      name             TEXT NOT NULL DEFAULT '',   -- 사용자가 카드에서 편집. bot_pc_tags.pc_tag와 매칭.
      ip               TEXT NOT NULL DEFAULT '',
      first_seen       INTEGER NOT NULL,
      last_seen        INTEGER NOT NULL,
      last_screenshot  INTEGER DEFAULT 0
    );
    -- ★ NEW: Active Bot 지정 테이블
    --   메소트래커 우클릭으로 "active bot"으로 표시한 봇만 등록.
    --   메소 부족 알람 / 오프라인 알람 / 아이템 매니지(charm,pet,fuel,ale)는
    --   이 테이블에 있는 봇만 대상으로 한다. (기존 Lv.260+ 필터를 대체)
    CREATE TABLE IF NOT EXISTS active_bots (
      ign        TEXT PRIMARY KEY,
      marked_at  INTEGER NOT NULL
    );
  `);
  // ── 기본 클라이언트 시드 (서버 재시작해도 항상 유지) ──
  const DEFAULT_CLIENTS = [
    { owner: "Hyeong", token_t: "b4e8a2f1c9d3705e6b2c4a8f1d5e9a7c3b6e2f4d8a0c5e1b9f3a7c2d6e4b8f0",
                       token_c: "b4e8a2f1c9d3705e6b2c4a8f1d5e9a7c3b6e2f4d8a0c5e1b9f3a7c2d6e4b8f0" },
  ];
  for (const c of DEFAULT_CLIENTS) {
    db.run("INSERT OR IGNORE INTO tokens  (owner, token) VALUES (?,?)", [c.owner, c.token_t]);
    db.run("INSERT OR IGNORE INTO clients (owner, token) VALUES (?,?)", [c.owner, c.token_c]);
  }
  persist();

  // ── 기존 DB 마이그레이션 ──
  try { db.run("ALTER TABLE private_data ADD COLUMN buff_count INTEGER DEFAULT NULL"); } catch(e) {}

  return db;
}
function persist() {
  if (!db) return;
  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
}
function run(sql, params=[]) { db.run(sql, params); persist(); }
function get(sql, params=[]) {
  const s = db.prepare(sql); s.bind(params);
  if (s.step()) { const r = s.getAsObject(); s.free(); return r; }
  s.free(); return null;
}
function all(sql, params=[]) {
  const out=[]; const s=db.prepare(sql); s.bind(params);
  while(s.step()) out.push(s.getAsObject());
  s.free(); return out;
}
module.exports = { getDb, run, get, all, persist };
