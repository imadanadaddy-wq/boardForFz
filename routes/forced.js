const express = require("express");
const router  = express.Router();
const dbMod   = require("../db");

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
    if (!client || client.token !== token)
      return res.status(403).json({ error: "Invalid token" });
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
router.delete("/", (req, res) => {
  const { owner, ign, token } = req.body || {};
  if (!owner || !ign || !token)
    return res.status(400).json({ error: "owner, ign, token required" });
  try {
    const client = dbMod.get("SELECT token FROM clients WHERE owner = ?", [owner]);
    if (!client || client.token !== token)
      return res.status(403).json({ error: "Invalid token" });
    dbMod.run(
      "DELETE FROM forced_offline WHERE owner = ? AND ign = ?",
      [owner, ign]
    );
    return res.json({ ok: true, owner, ign, forced: false });
  } catch (e) {
    console.error("[forced] DELETE error:", e);
    return res.status(500).json({ error: "DB error", detail: e.message });
  }
});

module.exports = router;
