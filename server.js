const express = require("express");
const cors    = require("cors");
const path    = require("path");
const fs      = require("fs");
const dbMod   = require("./db");

const app  = express();
const PORT = process.env.PORT || 3000;

// mapnames.json 경로 — public 폴더 안에 두면 GitHub에 커밋 가능
const MAPNAMES_PATH = path.join(__dirname, "public", "mapnames.json");

function loadMapNames() {
  try {
    if (fs.existsSync(MAPNAMES_PATH))
      return JSON.parse(fs.readFileSync(MAPNAMES_PATH, "utf8"));
  } catch(e) { console.error("[mapnames] load error:", e.message); }
  return {};
}
function saveMapNames(obj) {
  fs.writeFileSync(MAPNAMES_PATH, JSON.stringify(obj, null, 2), "utf8");
}

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.static(path.join(__dirname, "public")));

dbMod.getDb().then(() => {
  console.log("[DB] Ready");

  app.use("/api/tracker",              require("./routes/tracker"));
  app.use("/api/bot-heartbeat/client", require("./routes/heartbeat"));
  app.use("/api/seller",               require("./routes/seller"));

  // ── Map names (파일 기반 — GitHub에 영구 저장) ──
  app.get("/api/mapnames", (req, res) => {
    const obj = loadMapNames();
    const rows = Object.entries(obj).map(([map_id, map_name]) => ({ map_id, map_name }));
    return res.json(rows);
  });
  app.post("/api/mapnames", (req, res) => {
    const { map_id, map_name } = req.body;
    if (!map_id || !map_name) return res.status(400).json({ error: "map_id and map_name required" });
    const obj = loadMapNames();
    obj[String(map_id)] = map_name;
    saveMapNames(obj);
    return res.json({ ok: true });
  });
  app.delete("/api/mapnames/:id", (req, res) => {
    const obj = loadMapNames();
    delete obj[req.params.id];
    saveMapNames(obj);
    return res.json({ ok: true });
  });

  // ── Change log ──
  app.get("/api/bot-change-log", (req, res) => {
    const limit = parseInt(req.query.limit) || 300;
    const rows  = dbMod.all("SELECT * FROM bot_change_log ORDER BY ts DESC LIMIT ?", [limit]);
    return res.json(rows);
  });
  app.delete("/api/bot-change-log", (req, res) => {
    dbMod.run("DELETE FROM bot_change_log");
    return res.json({ ok: true });
  });

  app.post("/api/clients", (req, res) => {
    const { owner, token } = req.body;
    if (!owner || !token) return res.status(400).json({ error: "owner and token required" });
    try {
      dbMod.run("INSERT OR REPLACE INTO clients (owner, token) VALUES (?, ?)", [owner, token]);
      return res.json({ ok: true });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  });
  app.get("/api/clients", (req, res) => {
    return res.json(dbMod.all("SELECT owner FROM clients ORDER BY owner"));
  });

  app.get("*", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
  });

  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
});
