const express      = require("express");
const cors         = require("cors");
const path         = require("path");
const fs           = require("fs");
const cookieParser = require("cookie-parser");
const jwt          = require("jsonwebtoken");
const dbMod        = require("./db");

const app  = express();
const PORT = process.env.PORT || 3000;

// ══════════════════════════════════════
// ENV CONFIG
// ══════════════════════════════════════
const DISCORD_CLIENT_ID     = process.env.DISCORD_CLIENT_ID     || "";
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || "";
const DISCORD_REDIRECT_URI  = process.env.DISCORD_REDIRECT_URI  || `http://localhost:${PORT}/auth/callback`;
const JWT_SECRET            = process.env.JWT_SECRET            || "change-this-secret-in-production";
// 허용할 Discord 유저 ID 목록 (쉼표로 구분)
// 예: ALLOWED_USER_IDS=123456789,987654321
const ALLOWED_USER_IDS = (process.env.ALLOWED_USER_IDS || "")
  .split(",").map(s => s.trim()).filter(Boolean);

if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET) {
  console.warn("[AUTH] ⚠  DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET 환경변수가 없습니다.");
  console.warn("[AUTH]    .env 파일을 확인해주세요.");
}
if (ALLOWED_USER_IDS.length === 0) {
  console.warn("[AUTH] ⚠  ALLOWED_USER_IDS가 비어있습니다. 아무도 로그인할 수 없습니다.");
}

// ══════════════════════════════════════
// MIDDLEWARE
// ══════════════════════════════════════
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(cookieParser());

// JWT 인증 미들웨어 — 보호된 라우트에 사용
function requireAuth(req, res, next) {
  const token = req.cookies?.ms_token;
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.clearCookie("ms_token");
    res.status(401).json({ error: "Session expired" });
  }
}

// ══════════════════════════════════════
// STATIC FILES (HTML은 인증 후 서빙)
// ══════════════════════════════════════
// index.html은 아래 catch-all에서 인증 확인 후 서빙
app.use("/images", express.static(path.join(__dirname, "public", "images")));

// ══════════════════════════════════════
// DISCORD OAUTH2 ROUTES (공개)
// ══════════════════════════════════════

// Step 1: Discord 로그인 페이지로 리다이렉트
app.get("/auth/discord", (req, res) => {
  if (!DISCORD_CLIENT_ID) {
    return res.status(500).send("DISCORD_CLIENT_ID 환경변수가 설정되지 않았습니다.");
  }
  const params = new URLSearchParams({
    client_id:     DISCORD_CLIENT_ID,
    redirect_uri:  DISCORD_REDIRECT_URI,
    response_type: "code",
    scope:         "identify",
  });
  res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});

// Step 2: Discord 콜백 처리
app.get("/auth/callback", async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.redirect("/?error=discord_denied");

  try {
    // code → access_token 교환
    const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
      method:  "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body:    new URLSearchParams({
        client_id:     DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type:    "authorization_code",
        code,
        redirect_uri:  DISCORD_REDIRECT_URI,
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      console.error("[AUTH] Discord token error:", tokenData);
      return res.redirect("/?error=token_failed");
    }

    // 유저 정보 조회
    const userRes = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const user = await userRes.json();
    console.log(`[AUTH] Login attempt: ${user.username} (${user.id})`);

    // 화이트리스트 확인
    if (!ALLOWED_USER_IDS.includes(user.id)) {
      console.warn(`[AUTH] ❌ Denied: ${user.username} (${user.id})`);
      return res.redirect("/?error=unauthorized");
    }

    // JWT 발급 (7일)
    const payload = {
      id:            user.id,
      username:      user.username,
      discriminator: user.discriminator || "0",
      avatar:        user.avatar,
    };
    const jwtToken = jwt.sign(payload, JWT_SECRET, { expiresIn: "7d" });

    res.cookie("ms_token", jwtToken, {
      httpOnly: true,
      maxAge:   7 * 24 * 60 * 60 * 1000, // 7일 (ms)
      sameSite: "lax",
      secure:   process.env.NODE_ENV === "production", // HTTPS 환경에서만 secure
    });

    console.log(`[AUTH] ✅ Logged in: ${user.username} (${user.id})`);
    res.redirect("/");

  } catch (e) {
    console.error("[AUTH] callback error:", e);
    res.redirect("/?error=server_error");
  }
});

// 로그아웃
app.get("/auth/logout", (req, res) => {
  res.clearCookie("ms_token");
  res.redirect("/");
});

// 현재 로그인 유저 확인 (프론트에서 호출)
app.get("/api/me", (req, res) => {
  const token = req.cookies?.ms_token;
  if (!token) return res.json({ auth: false });
  try {
    const user = jwt.verify(token, JWT_SECRET);
    res.json({ auth: true, user });
  } catch {
    res.clearCookie("ms_token");
    res.json({ auth: false });
  }
});

// ══════════════════════════════════════
// MAP NAMES (파일 기반)
// ══════════════════════════════════════
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

// ══════════════════════════════════════
// DB READY → 라우트 등록
// ══════════════════════════════════════
dbMod.getDb().then(() => {
  console.log("[DB] Ready");

  // ── 봇 전용 라우트 (공개 — Lua 스크립트가 토큰으로 직접 호출) ──
  app.use("/api/bot-heartbeat/client", require("./routes/heartbeat"));

  // ── 인증 필요 라우트 ──
  app.use("/api/tracker",        require("./routes/tracker"));
  app.use("/api/seller",         requireAuth, require("./routes/seller"));
  app.use("/api/forced-offline", requireAuth, require("./routes/forced"));
  app.use("/api/management",     require("./routes/management").router);

  // Map names
  app.get("/api/mapnames", requireAuth, (req, res) => {
    const obj  = loadMapNames();
    const rows = Object.entries(obj).map(([map_id, map_name]) => ({ map_id, map_name }));
    return res.json(rows);
  });
  app.post("/api/mapnames", requireAuth, (req, res) => {
    const { map_id, map_name } = req.body;
    if (!map_id || !map_name) return res.status(400).json({ error: "map_id and map_name required" });
    const obj = loadMapNames();
    obj[String(map_id)] = map_name;
    saveMapNames(obj);
    return res.json({ ok: true });
  });
  app.delete("/api/mapnames/:id", requireAuth, (req, res) => {
    const obj = loadMapNames();
    delete obj[req.params.id];
    saveMapNames(obj);
    return res.json({ ok: true });
  });

  // Change log
  app.get("/api/bot-change-log", requireAuth, (req, res) => {
    const limit = parseInt(req.query.limit) || 300;
    const rows  = dbMod.all("SELECT * FROM bot_change_log ORDER BY ts DESC LIMIT ?", [limit]);
    return res.json(rows);
  });
  app.delete("/api/bot-change-log", requireAuth, (req, res) => {
    dbMod.run("DELETE FROM bot_change_log");
    return res.json({ ok: true });
  });

  // Clients
  app.post("/api/clients", requireAuth, (req, res) => {
    const { owner, token } = req.body;
    if (!owner || !token) return res.status(400).json({ error: "owner and token required" });
    try {
      dbMod.run("INSERT OR REPLACE INTO clients (owner, token) VALUES (?, ?)", [owner, token]);
      return res.json({ ok: true });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  });
  app.get("/api/clients", requireAuth, (req, res) => {
    return res.json(dbMod.all("SELECT owner FROM clients ORDER BY owner"));
  });

  // ── Catch-all: index.html 서빙 ──
  app.get("*", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
  });

  app.listen(PORT, () => {
    console.log(`[SERVER] ✅  Running on port ${PORT}`);
    console.log(`[AUTH]   Allowed users: ${ALLOWED_USER_IDS.length ? ALLOWED_USER_IDS.join(", ") : "(none)"}`);
  });
});
