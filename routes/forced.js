const express = require("express");
const router  = express.Router();
const dbMod   = require("../db");

function ensureManualReleasedTable() {
  dbMod.run(`
    CREATE TABLE IF NOT EXISTS manual_released (
      owner TEXT NOT NULL,
      ign   TEXT NOT NULL,
      PRIMARY KEY (owner, ign)
    )
  `);
}

// ── GET /api/forced-offline ──────────────────────────────────────────────────
router.get("/", (req, res) => {
  try {
    const rows = dbMod.all("SELECT owner, ign, forced_at FROM forced_offline ORDER BY owner, ign");
    return res.json(rows);
  } catch (e) {
    console.error("[forced] GET error:", e);
    return res.status(500).json({ error: "DB error", detail: e.message });
  }
});

// ── POST /api/forced-offline ─────────────────────────────────────────────────
router.post("/", (req, res) => {
  const { owner, ign, token } = req.body || {};
  if (!owner || !ign || !token)
    return res.status(400).json({ error: "owner, ign, token required" });
  try {
    const client = dbMod.get("SELECT token FROM clients WHERE owner = ?", [owner]);
    console.log("[forced] POST owner:", owner);
    console.log("[forced] recv  token:", token?.slice(0,12));
    console.log("[forced] DB    token:", client?.token?.slice(0,12) ?? "NOT FOUND");
    if (!client || client.token !== token)
      return res.status(403).json({
        error: "Invalid token",
        recv:  token?.slice(0,8) + "...",
        db:    client ? client.token?.slice(0,8) + "..." : "owner not found"
      });

    ensureManualReleasedTable();

    // 수동 강제(POST)는 manual_released에서 제거 → 이후 자동강제도 다시 허용
    dbMod.run("DELETE FROM manual_released WHERE owner=? AND ign=?", [owner, ign]);

    dbMod.run(
      "INSERT OR REPLACE INTO forced_offline (owner, ign, forced_at) VALUES (?, ?, ?)",
      [owner, ign, Date.now()]
    );
    return res.json({ ok: true, owner, ign, forced: true });
  } catch (e) {
    console.error("[forced] POST error:", e);
    return res.status(500).json({ error: "DB error", detail: e.message });
  }
});

// ── DELETE /api/forced-offline ───────────────────────────────────────────────
// 수동 해제 시 manual_released에 기록 → Lv.219 이하여도 재자동강제 방지
router.delete("/", (req, res) => {
  const { owner, ign, token } = req.body || {};
  if (!owner || !ign || !token)
    return res.status(400).json({ error: "owner, ign, token required" });
  try {
    const client = dbMod.get("SELECT token FROM clients WHERE owner = ?", [owner]);
    if (!client || client.token !== token)
      return res.status(403).json({
        error: "Invalid token",
        recv:  token?.slice(0,8) + "...",
        db:    client ? client.token?.slice(0,8) + "..." : "owner not found"
      });

    ensureManualReleasedTable();

    dbMod.run(
      "DELETE FROM forced_offline WHERE owner = ? AND ign = ?",
      [owner, ign]
    );
    // 수동 해제 기록: 이 봇은 자동강제 대상에서 영구 제외
    dbMod.run(
      "INSERT OR IGNORE INTO manual_released (owner, ign) VALUES (?, ?)",
      [owner, ign]
    );
    return res.json({ ok: true, owner, ign, forced: false, manuallyReleased: true });
  } catch (e) {
    console.error("[forced] DELETE error:", e);
    return res.status(500).json({ error: "DB error", detail: e.message });
  }
});

module.exports = router;
