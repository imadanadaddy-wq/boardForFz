const express = require("express");
const router  = express.Router();
const db      = require("../db");

// 안전망: 테이블 보장
db.run(`
  CREATE TABLE IF NOT EXISTS proxies (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ip         TEXT NOT NULL,
    port       TEXT NOT NULL,
    pid        TEXT DEFAULT '',
    pw         TEXT DEFAULT '',
    exp_ts     INTEGER DEFAULT NULL,
    memo       TEXT DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT 0
  )
`);

const DAY_MS = 24 * 60 * 60 * 1000;

// "7D"/"30d" → 지금+N일,  "MM/DD" 또는 "MM/DD HH:MM" → 해당 날짜(/시각),
// "YYYY-MM-DD" 또는 "YYYY-MM-DD HH:MM" → 절대,  빈값 → null
function parseExp(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s) return null;
  let m;
  if ((m = s.match(/^(\d+)\s*[dD]$/))) {            // 상대일 7D
    return Date.now() + parseInt(m[1], 10) * DAY_MS;
  }
  // MM/DD [HH:MM]  (연도 없음 → 올해, 이미 지났으면 내년)
  if ((m = s.match(/^(\d{1,2})[\/\-](\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?$/))) {
    const now = new Date();
    const mo = parseInt(m[1],10)-1, d = parseInt(m[2],10);
    const hh = m[3] !== undefined ? parseInt(m[3],10) : 23;
    const mi = m[4] !== undefined ? parseInt(m[4],10) : 59;
    let dt = new Date(now.getFullYear(), mo, d, hh, mi, 0);
    if (dt.getTime() < now.getTime() - DAY_MS) dt = new Date(now.getFullYear()+1, mo, d, hh, mi, 0);
    return dt.getTime();
  }
  // YYYY-MM-DD [HH:MM]
  if ((m = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?$/))) {
    const hh = m[4] !== undefined ? parseInt(m[4],10) : 23;
    const mi = m[5] !== undefined ? parseInt(m[5],10) : 59;
    return new Date(parseInt(m[1],10), parseInt(m[2],10)-1, parseInt(m[3],10), hh, mi, 0).getTime();
  }
  const t = Date.parse(s);
  return isNaN(t) ? null : t;
}

// GET /api/proxies — 목록 (만료 임박 순 아님, sort_order/id 순)
router.get("/", (req, res) => {
  const rows = db.all("SELECT * FROM proxies ORDER BY sort_order ASC, id ASC");
  res.json(rows);
});

// POST /api/proxies/bulk — 대량 추가
// body: { text: "ip:port:id:pw:7D\nip:port:id:pw:30D\n..." }
router.post("/bulk", (req, res) => {
  const text = String(req.body.text || "");
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const now = Date.now();
  let base = db.get("SELECT MAX(sort_order) AS m FROM proxies");
  let order = (base && base.m) ? base.m : 0;
  const added = [];
  const skipped = [];
  for (const line of lines) {
    // ip:port:id:pw:exp  (id/pw/exp는 생략 가능)
    const parts = line.split(":");
    if (parts.length < 2) { skipped.push(line); continue; }
    const ip   = parts[0].trim();
    const port = parts[1].trim();
    if (!ip || !port) { skipped.push(line); continue; }
    const pid  = (parts[2] || "").trim();
    const pw   = (parts[3] || "").trim();
    const exp  = parseExp(parts[4] || "");
    order += 1;
    db.run(
      "INSERT INTO proxies (ip,port,pid,pw,exp_ts,memo,sort_order,created_at) VALUES (?,?,?,?,?,?,?,?)",
      [ip, port, pid, pw, exp, "", order, now]
    );
    added.push(line);
  }
  res.json({ ok: true, added: added.length, skipped });
});

// PATCH /api/proxies/:id — 만료일 또는 메모 수정
// body: { exp?: "7D"|"MM/DD"|"" , memo?: "..." }
router.patch("/:id", (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: "bad id" });
  const row = db.get("SELECT * FROM proxies WHERE id=?", [id]);
  if (!row) return res.status(404).json({ error: "not found" });
  const sets = [], vals = [];
  if (req.body.exp !== undefined) { sets.push("exp_ts=?"); vals.push(parseExp(req.body.exp)); }
  if (req.body.memo !== undefined) { sets.push("memo=?"); vals.push(String(req.body.memo)); }
  if (req.body.ip !== undefined)   { sets.push("ip=?");   vals.push(String(req.body.ip).trim()); }
  if (req.body.port !== undefined) { sets.push("port=?"); vals.push(String(req.body.port).trim()); }
  if (req.body.pid !== undefined)  { sets.push("pid=?");  vals.push(String(req.body.pid).trim()); }
  if (req.body.pw !== undefined)   { sets.push("pw=?");   vals.push(String(req.body.pw).trim()); }
  if (!sets.length) return res.json({ ok: true });
  vals.push(id);
  db.run(`UPDATE proxies SET ${sets.join(", ")} WHERE id=?`, vals);
  res.json({ ok: true, proxy: db.get("SELECT * FROM proxies WHERE id=?", [id]) });
});

// DELETE /api/proxies/:id
router.delete("/:id", (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: "bad id" });
  db.run("DELETE FROM proxies WHERE id=?", [id]);
  res.json({ ok: true });
});

module.exports = router;
