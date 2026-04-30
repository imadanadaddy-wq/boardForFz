const express = require("express");
const router  = express.Router();
const db      = require("../db");

router.post("/", (req, res) => {
  const { owner, token, ign, level, meso, meso_hr, items } = req.body;
  if (!owner || !token || !ign)
    return res.status(400).json({ error: "Missing fields" });
  const client = db.get("SELECT * FROM tokens WHERE owner = ?", [owner]);
  if (!client)                return res.status(401).json({ error: "Unknown owner" });
  if (client.token !== token) return res.status(401).json({ error: "Invalid token" });
  db.run(`INSERT INTO private_data (owner,ign,level,meso,meso_hr,items,last_seen)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(owner,ign) DO UPDATE SET
      level=excluded.level,meso=excluded.meso,meso_hr=excluded.meso_hr,
      items=excluded.items,last_seen=excluded.last_seen`,
    [owner,ign,level||0,meso||0,meso_hr||0,JSON.stringify(items||[]),Date.now()]);
  return res.json({ ok: true });
});

router.get("/", (req, res) => {
  const now  = Date.now();
  const rows = db.all("SELECT * FROM private_data ORDER BY meso_hr DESC");
  return res.json(rows.map(r => ({
    ...r, items: JSON.parse(r.items||"[]"),
    online: (now-r.last_seen)<120000,
    ago_sec: Math.floor((now-r.last_seen)/1000)
  })));
});

module.exports = router;
