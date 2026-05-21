const express = require("express");
const router  = express.Router();
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

// GET /api/fz — 전체 목록 (순서대로)
router.get("/", (req, res) => {
  const rows = db.all("SELECT * FROM fz_list ORDER BY sort_order ASC, id ASC");
  res.json(rows);
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
    res.status(409).json({ error: "이미 존재하는 IGN" });
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

module.exports = router;
