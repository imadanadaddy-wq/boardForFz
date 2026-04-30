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
      items     TEXT DEFAULT '[]',
      ts        INTEGER,
      last_seen INTEGER NOT NULL,
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
  `);

  // ── 기본 클라이언트 시드 (서버 재시작해도 항상 유지) ──
  // INSERT OR IGNORE 이므로 중복 삽입 없음
  const DEFAULT_CLIENTS = [
    { owner: "Hyeong", token_t: "fd9601cc2d89007ea64825510908023994b55e445d8d930ed582f7a8532afe30",
                       token_c: "b5e3720c6f67aed053c977b9a70f1587c746f09410b24dac02cca866e6d2deda" },
  ];
  for (const c of DEFAULT_CLIENTS) {
    db.run("INSERT OR IGNORE INTO tokens  (owner, token) VALUES (?,?)", [c.owner, c.token_t]);
    db.run("INSERT OR IGNORE INTO clients (owner, token) VALUES (?,?)", [c.owner, c.token_c]);
  }

  persist();
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
