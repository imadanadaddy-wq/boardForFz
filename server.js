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

// ★ PIN 인증 — Discord 차단 환경용 (로그인 페이지 로고 5회 클릭 → PIN 입력)
const AUTH_PIN = process.env.AUTH_PIN || "7678";
app.post("/auth/pin", express.json(), (req, res) => {
  const pin = String(req.body?.pin || "").trim();
  if (pin !== AUTH_PIN) return res.status(401).json({ error: "wrong pin" });
  const payload = { id: "pin-owner", username: "Owner", method: "pin" };
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: "7d" });
  res.cookie("ms_token", token, {
    httpOnly: true, secure: true, sameSite: "lax", maxAge: 7 * 24 * 60 * 60 * 1000
  });
  res.json({ ok: true });
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
// MAP NAMES  (SQLite map_names, 그룹별 (grp, map_id))
//   전역 관리 테이블(메소트래커/FZ 마스터)은 표시용으로 병합(rudy 우선) 사용.
//   실제 편집/저장은 그룹 컨텍스트가 있는 /api/fz/mapname 에서 수행.
// ══════════════════════════════════════
function loadMapNamesMerged() {
  const out = {};
  try {
    // gabi 먼저 깔고 rudy로 덮어써 rudy 우선
    for (const r of dbMod.all("SELECT map_id, map_name FROM map_names WHERE grp='gabi'")) out[String(r.map_id)] = r.map_name;
    for (const r of dbMod.all("SELECT map_id, map_name FROM map_names WHERE grp='rudy'")) out[String(r.map_id)] = r.map_name;
  } catch (e) { console.error("[mapnames] load error:", e.message); }
  return out;
}
function saveMapName(grp, mapId, name) {
  dbMod.run(
    `INSERT INTO map_names (grp, map_id, map_name) VALUES (?,?,?)
     ON CONFLICT(grp, map_id) DO UPDATE SET map_name=excluded.map_name`,
    [grp || "rudy", String(mapId), String(name).slice(0, 200)]
  );
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
  // ★ 그룹 키 노출/회전은 인증 필요
  app.use("/api/fz/groups",      requireAuth);
  // ★ 전체 배정 조회 (마스터 테이블용)
  app.use("/api/fz/all",         requireAuth);
  app.use("/api/fz/meso-config",  requireAuth);
  // ★ FZ 쓰기(추가/삭제/정렬/배정)는 인증 필요 — GET만 공개(그룹키로 자체 보호)
  app.use("/api/fz", (req, res, next) => {
    if (req.method !== "GET") {
      // 순서 변경 + 맵 컬러 + 맵 이름은 공개 (저위험, 어느 대시보드에서든 편집 가능)
      if (req.path === "/reorder" || req.path === "/map-colors" || req.path === "/mapname") return next();
      return requireAuth(req, res, next);
    }
    next();
  });
  app.use("/api/fz",             require("./routes/fz"));

  app.use("/api/proxies",        requireAuth, require("./routes/proxies"));

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
      dbMod.run("DELETE FROM fz_list         WHERE ign=?", [ign]);  // ★ FZ 그룹 배정 제거
      try { dbMod.run("DELETE FROM bot_meso_config WHERE ign=?", [ign]); } catch(e){}  // ★ 메획 설정(있으면)
      // ★ CHANGED: active_bots는 보존 (영구 등록 의도). 봇이 다시 ONLINE 되면 즉시 active로 인식됨.
      //            만약 사용자가 active 해제도 원하면 우클릭 메뉴에서 명시적으로 처리.
      console.log(`[BOT-DELETE] ✅ Removed all records for ign=${ign} by ${req.user?.username}`);
      return res.json({ ok: true, ign, deleted: true });
    } catch (e) {
      console.error("[BOT-DELETE] error:", e);
      return res.status(500).json({ error: e.message });
    }
  });

  // Map names  (GET=병합 표시용 / POST=그룹별 저장 / DELETE=그룹별)
  app.get("/api/mapnames", requireAuth, (req, res) => {
    const obj  = loadMapNamesMerged();
    const rows = Object.entries(obj).map(([map_id, map_name]) => ({ map_id, map_name }));
    return res.json(rows);
  });
  app.post("/api/mapnames", requireAuth, (req, res) => {
    const { map_id, map_name } = req.body;
    const grp = (req.body.grp || req.query.grp || "rudy").toString().trim().toLowerCase() || "rudy";
    if (!map_id || !map_name) return res.status(400).json({ error: "map_id and map_name required" });
    saveMapName(grp, map_id, map_name);
    return res.json({ ok: true, grp, map_id: String(map_id), map_name: String(map_name).slice(0, 200) });
  });
  app.delete("/api/mapnames/:id", requireAuth, (req, res) => {
    const grp = (req.query.grp || "").toString().trim().toLowerCase();
    if (grp) dbMod.run("DELETE FROM map_names WHERE grp=? AND map_id=?", [grp, String(req.params.id)]);
    else     dbMod.run("DELETE FROM map_names WHERE map_id=?", [String(req.params.id)]);
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
  //     루트를 /gabi 로 보거나, 그냥 https://hyeongfz.../gabi 를 Gabi에게 주면 됨
  //   - 서버가 gabi 그룹 키를 페이지에 주입 → 정적 파일/깃에 키를 박지 않음
  //   - 이 페이지는 gabi 그룹 리스트만 읽기전용으로 표시 (rudy 리스트/시크릿 접근 불가)
  // ════════════════════════════════════════════════════════════════
  const GABI_HTML_PATH = path.join(__dirname, "public", "gabi.html");
  app.get(["/gabi", "/gabi.html"], (req, res) => serveGabiPage(res));

  // ★ NEW: RUDY 전용 읽기전용 페이지 (공개 — 키 불필요)
  const RUDY_HTML_PATH = path.join(__dirname, "public", "rudy.html");
  app.get(["/rudy", "/rudy.html"], (req, res) => {
    let html = "";
    try { html = fs.readFileSync(RUDY_HTML_PATH, "utf8"); }
    catch { return res.status(500).send("rudy.html missing"); }
    res.set("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  });

  // Catch-all — ★★★ 메인 대시보드는 OAuth 인증 후에만 접근 가능 ★★★
  // /rudy, /gabi, /auth/*, /api/*, /images/* 는 위에서 이미 처리됨
  app.get("*", (req, res) => {
    const token = req.cookies?.ms_token;
    if (token) {
      try {
        jwt.verify(token, JWT_SECRET);
        return res.sendFile(path.join(__dirname, "public", "index.html"));
      } catch(e) { /* 만료/무효 → 아래 로그인 페이지 */ }
    }
    // 미인증 → 미니멀 로그인 페이지 (로고 5클릭 → PIN 입력)
    res.send(`<!DOCTYPE html><html lang="ko"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>HyeongFZ — Login</title>
<link rel="icon" href="/images/cat-logo.png">
<style>
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
  background:#0f1115;color:#e7eaee;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.card{text-align:center;padding:48px 40px;background:#161a20;border:1px solid #2a2f37;border-radius:16px;
  box-shadow:0 4px 24px rgba(0,0,0,.5);max-width:380px;width:90%}
.card img{width:64px;height:64px;border-radius:14px;margin-bottom:18px;cursor:pointer;
  -webkit-user-select:none;user-select:none;transition:transform .1s}
.card img:active{transform:scale(.92)}
.card h1{font-size:22px;font-weight:800;margin:0 0 6px;letter-spacing:.5px}
.card p{font-size:13px;color:#9aa3ad;margin:0 0 28px;line-height:1.5}
.btn{display:inline-flex;align-items:center;gap:8px;padding:12px 28px;background:#5865F2;color:#fff;
  border:none;border-radius:8px;font-size:14px;font-weight:700;cursor:pointer;text-decoration:none;
  transition:background .15s}
.btn:hover{background:#4752c4}
.links{margin-top:24px;font-size:12px;color:#555}
.links a{color:#00bcd4;text-decoration:none}
#pin-box{display:none;margin-top:20px}
#pin-box input{background:#0d0f12;border:1px solid #2a2f37;color:#9fe;padding:10px 14px;border-radius:8px;
  font-size:16px;font-family:'JetBrains Mono',monospace;width:140px;text-align:center;letter-spacing:4px;
  -webkit-text-security:disc}
#pin-box button{margin-left:8px;padding:10px 18px;background:#00bcd4;color:#fff;border:none;border-radius:8px;
  font-size:13px;font-weight:700;cursor:pointer}
#pin-err{color:#e74c3c;font-size:11px;margin-top:8px;display:none}
</style></head><body>
<div class="card">
  <img id="logo" src="/images/cat-logo.png" alt="">
  <h1>HyeongFZ</h1>
  <p>대시보드에 접근하려면 로그인이 필요합니다.</p>
  <a class="btn" href="/auth/discord">
    <svg width="20" height="15" viewBox="0 0 71 55" fill="#fff"><path d="M60.1 4.9A58.5 58.5 0 0045.4.2a.2.2 0 00-.2.1 40.7 40.7 0 00-1.8 3.7 54 54 0 00-16.2 0A26.4 26.4 0 0025.4.3a.2.2 0 00-.2-.1A58.4 58.4 0 0010.5 4.9a.2.2 0 00-.1.1C1.5 18.7-.9 32.2.3 45.5v.1a58.7 58.7 0 0017.9 9.1.2.2 0 00.3-.1 42 42 0 003.6-5.9.2.2 0 00-.1-.3 38.6 38.6 0 01-5.5-2.7.2.2 0 01 0-.4l1.1-.9a.2.2 0 01.2 0 41.9 41.9 0 0035.6 0 .2.2 0 01.3 0l1 .9a.2.2 0 010 .3 36.2 36.2 0 01-5.5 2.7.2.2 0 00-.1.4 47.1 47.1 0 003.6 5.8.2.2 0 00.2.1A58.5 58.5 0 0070.4 45.7v-.2C72 30.1 68 16.7 60.1 5a.2.2 0 000-.1zM23.7 37.3c-3.5 0-6.4-3.2-6.4-7.2s2.8-7.1 6.4-7.1 6.5 3.2 6.4 7.1c0 4-2.8 7.2-6.4 7.2zm23.6 0c-3.5 0-6.4-3.2-6.4-7.2s2.8-7.1 6.4-7.1 6.5 3.2 6.4 7.1c0 4-2.9 7.2-6.4 7.2z"/></svg>
    Login with Discord
  </a>
  <div id="pin-box">
    <input id="pin-input" type="password" maxlength="10" placeholder="PIN" inputmode="numeric"
      onkeydown="if(event.key==='Enter')submitPin()">
    <button onclick="submitPin()">→</button>
    <div id="pin-err">Wrong PIN</div>
  </div>
  <div class="links">
    FZ: <a href="/rudy">/rudy</a> · <a href="/gabi">/gabi</a>
  </div>
</div>
<script>
let _lc=0,_lt=0;
document.getElementById("logo").addEventListener("click",()=>{
  const now=Date.now();
  if(now-_lt>2000) _lc=0;
  _lt=now; _lc++;
  if(_lc>=5){
    _lc=0;
    const box=document.getElementById("pin-box");
    box.style.display="block";
    document.getElementById("pin-input").focus();
  }
});
async function submitPin(){
  const pin=document.getElementById("pin-input").value;
  if(!pin) return;
  try{
    const res=await fetch("/auth/pin",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({pin})});
    if(res.ok){ location.href="/"; }
    else{ document.getElementById("pin-err").style.display="block"; document.getElementById("pin-input").value=""; }
  }catch(e){ document.getElementById("pin-err").style.display="block"; }
}
</script>
</body></html>`);
  });

  app.listen(PORT, () => {
    console.log(`[SERVER] ✅  Running on port ${PORT}`);
    console.log(`[AUTH]   Allowed users: ${ALLOWED_USER_IDS.length ? ALLOWED_USER_IDS.join(", ") : "(none)"}`);
  });
});
