const express      = require("express");
const cors         = require("cors");
const path         = require("path");
const fs           = require("fs");
const cookieParser = require("cookie-parser");
const jwt          = require("jsonwebtoken");
const dbMod        = require("./db");

const app  = express();
const PORT = process.env.PORT || 3000;

// ★★★ Railway/Heroku 등 reverse proxy 뒤에서 동작 시 필수 ★★★
// 이걸 안 켜면: req.secure가 항상 false → Secure 쿠키가 정상 동작 안할 수 있음
app.set('trust proxy', 1);

// ══════════════════════════════════════
// ENV CONFIG
// ══════════════════════════════════════
const DISCORD_CLIENT_ID     = process.env.DISCORD_CLIENT_ID     || "";
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || "";
const DISCORD_REDIRECT_URI  = process.env.DISCORD_REDIRECT_URI  || `http://localhost:${PORT}/auth/callback`;
const JWT_SECRET            = process.env.JWT_SECRET            || "change-this-secret-in-production";
const ALLOWED_USER_IDS = (process.env.ALLOWED_USER_IDS || "")
  .split(",").map(s => s.trim()).filter(Boolean);

if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET) {
  console.warn("[AUTH] ⚠  DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET 환경변수가 없습니다.");
}
if (ALLOWED_USER_IDS.length === 0) {
  console.warn("[AUTH] ⚠  ALLOWED_USER_IDS가 비어있습니다. 아무도 로그인할 수 없습니다.");
}
console.log(`[AUTH] CLIENT_ID set: ${!!DISCORD_CLIENT_ID}, REDIRECT_URI: ${DISCORD_REDIRECT_URI}, ALLOWED count: ${ALLOWED_USER_IDS.length}`);

// ══════════════════════════════════════
// MIDDLEWARE
// ══════════════════════════════════════
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(cookieParser());

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
// ★ NEW: GABI 전용 도메인 (host 기반 라우팅)
//   - gabi.up.railway.app 로 들어오면 루트(/)에서 gabi 보드만 노출
//   - 메인 대시보드/인증 API/타 그룹은 이 도메인에서 전부 차단(읽기전용 게이트)
//   - 같은 서비스/같은 DB → 단일 원본 유지, 2nd 서비스 불필요
// ══════════════════════════════════════
const GABI_HOST       = (process.env.GABI_HOST || "gabi.up.railway.app").toLowerCase();
const GABI_HTML_FILE  = path.join(__dirname, "public", "gabi.html");

function reqHost(req) {
  return (req.headers.host || req.hostname || "").toLowerCase().split(":")[0];
}
function isGabiHost(req) {
  const h = reqHost(req);
  return h === GABI_HOST || h.startsWith("gabi.");   // 서브도메인 prefix도 허용
}
function serveGabiPage(res) {
  let html = "";
  try { html = fs.readFileSync(GABI_HTML_FILE, "utf8"); }
  catch { return res.status(500).send("gabi.html missing"); }
  const g   = dbMod.get("SELECT api_key FROM fz_groups WHERE grp='gabi'");
  const key = (g && g.api_key) ? g.api_key : "";
  res.set("Content-Type", "text/html; charset=utf-8");
  res.send(html.replace("__FZ_GABI_KEY__", key));
}

// gabi 도메인 게이트 — 모든 라우트보다 먼저 평가
app.use((req, res, next) => {
  if (!isGabiHost(req)) return next();           // 메인 도메인은 그대로 통과
  const p = req.path;

  // 루트 또는 /gabi → gabi 보드
  if (p === "/" || p === "/gabi" || p === "/gabi.html") return serveGabiPage(res);
  // 이미지/파비콘만 정적 허용
  if (p.startsWith("/images/") || p === "/favicon.ico") return next();
  // gabi 스코프 읽기 API만 허용 (grp=gabi 강제)
  if ((p === "/api/fz" || p === "/api/fz/status") && req.method === "GET") {
    if ((req.query.grp || "").toLowerCase() !== "gabi") {
      return res.status(403).json({ error: "forbidden on gabi host" });
    }
    return next();
  }
  // 그 외(메인 대시보드, 인증 API, 다른 그룹 등) 전부 차단
  return res.redirect("/");
});

// ══════════════════════════════════════
// STATIC FILES
// ══════════════════════════════════════
app.use("/images", express.static(path.join(__dirname, "public", "images")));

// ══════════════════════════════════════
// DISCORD OAUTH2 ROUTES
// ══════════════════════════════════════
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

app.get("/auth/callback", async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.redirect("/?error=discord_denied");

  try {
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
      return res.redirect("/?error=token_failed&detail=" + encodeURIComponent(tokenData.error || "unknown"));
    }

    const userRes = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const user = await userRes.json();
    console.log(`[AUTH] Login attempt: ${user.username} (${user.id})`);

    if (!ALLOWED_USER_IDS.includes(user.id)) {
      console.warn(`[AUTH] ❌ Denied: ${user.username} (${user.id}). Whitelisted IDs: [${ALLOWED_USER_IDS.join(", ")}]`);
      // ★ 본인 ID를 URL에 담아 화면에 표시 → ALLOWED_USER_IDS에 어떤 ID를 추가해야 하는지 즉시 확인 가능
      return res.redirect(`/?error=unauthorized&uid=${encodeURIComponent(user.id)}&uname=${encodeURIComponent(user.username)}`);
    }

    const payload = {
      id:            user.id,
      username:      user.username,
      discriminator: user.discriminator || "0",
      avatar:        user.avatar,
    };
    const jwtToken = jwt.sign(payload, JWT_SECRET, { expiresIn: "7d" });

    res.cookie("ms_token", jwtToken, {
      httpOnly: true,
      maxAge:   7 * 24 * 60 * 60 * 1000,
      sameSite: "lax",
      secure:   true,  // Railway = 항상 HTTPS
      path:     "/",
    });

    console.log(`[AUTH] ✅ Logged in: ${user.username} (${user.id}) — cookie set, redirecting to /`);
    res.redirect("/");

  } catch (e) {
    console.error("[AUTH] callback error:", e);
    res.redirect("/?error=server_error&detail=" + encodeURIComponent(e.message || "unknown"));
  }
});

app.get("/auth/logout", (req, res) => {
  res.clearCookie("ms_token");
  res.redirect("/");
});

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

// ★ 환경설정 진단 엔드포인트 (시크릿은 노출 안 함, 존재 여부만)
app.get("/api/auth/debug", (req, res) => {
  res.json({
    client_id_set:     !!DISCORD_CLIENT_ID,
    client_secret_set: !!DISCORD_CLIENT_SECRET,
    redirect_uri:      DISCORD_REDIRECT_URI,
    jwt_secret_set:    JWT_SECRET !== "change-this-secret-in-production",
    allowed_user_count: ALLOWED_USER_IDS.length,
    allowed_user_ids:   ALLOWED_USER_IDS,
    node_env:          process.env.NODE_ENV || "(not set)",
  });
});

// ★★★ 쿠키 진단 — 브라우저가 쿠키를 보내고 있는지 확인 ★★★
app.get("/api/cookie-debug", (req, res) => {
  let jwt_status = "no_cookie";
  let jwt_payload = null;
  if (req.cookies?.ms_token) {
    try {
      jwt_payload = jwt.verify(req.cookies.ms_token, JWT_SECRET);
      jwt_status = "valid";
    } catch (e) {
      jwt_status = "invalid: " + e.message;
    }
  }
  res.json({
    cookies_seen:       Object.keys(req.cookies || {}),
    has_ms_token:       !!req.cookies?.ms_token,
    ms_token_length:    req.cookies?.ms_token?.length || 0,
    jwt_status,
    jwt_payload,
    raw_cookie_header:  req.headers.cookie || "(none)",
    host:               req.headers.host,
    protocol_seen:      req.protocol,           // 'http' or 'https'
    req_secure:         req.secure,             // trust proxy 작동 시 true
    x_forwarded_proto:  req.headers['x-forwarded-proto'] || "(none)",
  });
});

// ══════════════════════════════════════
// MAP NAMES
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
// DB READY → ROUTES
// ══════════════════════════════════════
dbMod.getDb().then(() => {
  console.log("[DB] Ready");

  // 봇 전용 (공개 — Lua 토큰)
  app.use("/api/bot-heartbeat/client", require("./routes/heartbeat"));

  // ★★★ NEW: PC 관리 ★★★
  //   - /register, /heartbeat, /screenshot 는 라우터 내부에서 owner/token 검증 (Electron이 호출)
  //   - /list, PATCH/DELETE/:pc_id, /screenshot/:pc_id 는 라우터 내부에서 requireAuth
  app.use("/api/pc", require("./routes/pc"));

  // ★★★ NEW: 오버레이 다운로드 ★★★
  app.use("/api/downloads", require("./routes/downloads"));

  // 인증 필요
  app.use("/api/tracker",        require("./routes/tracker"));
  app.use("/api/seller",         requireAuth, require("./routes/seller"));
  app.use("/api/forced-offline", requireAuth, require("./routes/forced"));
  app.use("/api/management",     require("./routes/management").router);
  // ★ NEW: 그룹 키 노출/회전은 인증 필요 (그 외 /api/fz/* 는 그룹키로 자체 보호)
  app.use("/api/fz/groups",      requireAuth);
  app.use("/api/fz",             require("./routes/fz"));

  // ★★★ NEW: PC 태그 API ★★★
  app.get("/api/bot-tags", requireAuth, (req, res) => {
    const rows = dbMod.all("SELECT ign, pc_tag, updated_at FROM bot_pc_tags ORDER BY ign");
    return res.json(rows);
  });
  app.post("/api/bot-tags", requireAuth, (req, res) => {
    const { ign, pc_tag } = req.body;
    if (!ign) return res.status(400).json({ error: "ign required" });
    const now = Date.now();
    if (!pc_tag || !pc_tag.trim()) {
      dbMod.run("DELETE FROM bot_pc_tags WHERE ign=?", [ign]);
      return res.json({ ok: true, ign, pc_tag: "", deleted: true });
    }
    const tag = pc_tag.trim().slice(0, 32);
    dbMod.run(
      `INSERT INTO bot_pc_tags (ign, pc_tag, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(ign) DO UPDATE SET pc_tag=excluded.pc_tag, updated_at=excluded.updated_at`,
      [ign, tag, now]
    );
    return res.json({ ok: true, ign, pc_tag: tag });
  });
  app.delete("/api/bot-tags/:ign", requireAuth, (req, res) => {
    dbMod.run("DELETE FROM bot_pc_tags WHERE ign=?", [req.params.ign]);
    return res.json({ ok: true });
  });

  // ════════════════════════════════════════════════════════════════
  // ★★★ NEW: ACTIVE BOTS API ★★★
  //   - 메소트래커에서 우클릭으로 "active bot" 토글
  //   - 메소 부족 알람 / 오프라인 알람 / 아이템 매니지는 이 봇만 대상
  //   - 기존 Lv.260+ 필터를 완전히 대체
  // ════════════════════════════════════════════════════════════════
  app.get("/api/active-bots", requireAuth, (req, res) => {
    const rows = dbMod.all("SELECT ign, marked_at FROM active_bots ORDER BY ign");
    return res.json(rows);
  });
  app.post("/api/active-bots", requireAuth, (req, res) => {
    const { ign, active } = req.body || {};
    if (!ign) return res.status(400).json({ error: "ign required" });
    const now = Date.now();
    if (active === false) {
      dbMod.run("DELETE FROM active_bots WHERE ign=?", [ign]);
      return res.json({ ok: true, ign, active: false });
    }
    dbMod.run(
      "INSERT INTO active_bots (ign, marked_at) VALUES (?, ?) ON CONFLICT(ign) DO UPDATE SET marked_at=excluded.marked_at",
      [ign, now]
    );
    return res.json({ ok: true, ign, active: true, marked_at: now });
  });
  app.delete("/api/active-bots/:ign", requireAuth, (req, res) => {
    dbMod.run("DELETE FROM active_bots WHERE ign=?", [req.params.ign]);
    return res.json({ ok: true });
  });

  // ★ NEW: 레거시 raw evasion 로그 정리 (v3.2 이전에 쌓인 별도 EVADE 행 일괄 삭제)
  app.delete("/api/changelog/cleanup-evasion", requireAuth, (req, res) => {
    const result = dbMod.run("DELETE FROM bot_change_log WHERE field='evasion'");
    console.log(`[CLEANUP] removed raw evasion rows`);
    return res.json({ ok: true });
  });

  // ★★★ NEW: 봇 완전 삭제 (메소트래커 + 하트비트 + 메소히스토리 + PC태그 + 강제오프라인) ★★★
  app.delete("/api/bot/:ign", requireAuth, (req, res) => {
    const ign = req.params.ign;
    if (!ign) return res.status(400).json({ error: "ign required" });
    try {
      dbMod.run("DELETE FROM private_data    WHERE ign=?", [ign]);
      dbMod.run("DELETE FROM heartbeats      WHERE ign=?", [ign]);
      dbMod.run("DELETE FROM meso_history    WHERE ign=?", [ign]);
      dbMod.run("DELETE FROM bot_pc_tags     WHERE ign=?", [ign]);
      dbMod.run("DELETE FROM forced_offline  WHERE ign=?", [ign]);
      dbMod.run("DELETE FROM bot_change_log  WHERE ign=?", [ign]);
      dbMod.run("DELETE FROM meso_alert_log  WHERE ign=?", [ign]);
      // ★ CHANGED: active_bots는 보존 (영구 등록 의도). 봇이 다시 ONLINE 되면 즉시 active로 인식됨.
      //            만약 사용자가 active 해제도 원하면 우클릭 메뉴에서 명시적으로 처리.
      console.log(`[BOT-DELETE] ✅ Removed all records for ign=${ign} by ${req.user?.username}`);
      return res.json({ ok: true, ign, deleted: true });
    } catch (e) {
      console.error("[BOT-DELETE] error:", e);
      return res.status(500).json({ error: e.message });
    }
  });

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

  // ════════════════════════════════════════════════════════════════
  // ★★★ NEW: GABI 전용 더미 사이트 ★★★
  //   - gabi.up.railway.app 도메인(또는 2nd Railway 서비스)을 이 앱에 연결하고
  //     루트를 /gabi 로 보거나, 그냥 https://rudyfz.../gabi 를 Gabi에게 주면 됨
  //   - 서버가 gabi 그룹 키를 페이지에 주입 → 정적 파일/깃에 키를 박지 않음
  //   - 이 페이지는 gabi 그룹 리스트만 읽기전용으로 표시 (rudy 리스트/시크릿 접근 불가)
  // ════════════════════════════════════════════════════════════════
  const GABI_HTML_PATH = path.join(__dirname, "public", "gabi.html");
  app.get(["/gabi", "/gabi.html"], (req, res) => serveGabiPage(res));

  // Catch-all
  app.get("*", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
  });

  app.listen(PORT, () => {
    console.log(`[SERVER] ✅  Running on port ${PORT}`);
    console.log(`[AUTH]   Allowed users: ${ALLOWED_USER_IDS.length ? ALLOWED_USER_IDS.join(", ") : "(none)"}`);
  });
});
