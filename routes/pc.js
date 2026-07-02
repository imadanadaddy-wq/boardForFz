// ════════════════════════════════════════════════════════════════════
// routes/pc.js — PC 관리 API
//
// 클라이언트(Electron) 측:
//   POST /api/pc/register   { pc_id, owner, token }           — 부팅 시 1회
//   POST /api/pc/heartbeat  { pc_id, owner, token }           — 30초마다
//   POST /api/pc/screenshot { pc_id, owner, token, image_b64 } — 30분마다 (JPEG base64)
//
// 대시보드(웹) 측 (requireAuth 적용):
//   GET    /api/pc/list                                       — 카드 데이터 (PC + 매칭 봇)
//   PATCH  /api/pc/:pc_id   { name }                          — PC 이름 수정
//   DELETE /api/pc/:pc_id                                     — 카드 삭제
//   GET    /api/pc/screenshot/:pc_id                          — 캐시된 JPEG 반환
//
// ※ 스크린샷은 디스크/DB에 저장하지 않음. 인메모리 1장만 보관, 30분마다 덮어씀.
// ════════════════════════════════════════════════════════════════════
const express  = require("express");
const router   = express.Router();
const db       = require("../db");
const jwt      = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "change-this-secret-in-production";

// ── 오프라인 판정 기준: 5분 신호 없으면 오프라인 ──
const OFFLINE_THRESHOLD_MS = 5 * 60 * 1000;

// ── 스크린샷 인메모리 캐시 ──
//    key: pc_id, value: { buffer: Buffer, mime: 'image/jpeg', ts: epoch_ms }
const _screenshotCache = new Map();
const SCREENSHOT_MAX_AGE_MS = 65 * 60 * 1000;  // 65분 지나면 GC (정상 갱신 주기 30분의 ~2배)
const SCREENSHOT_MAX_BYTES  = 4 * 1024 * 1024; // 1장당 최대 4MB

function gcScreenshotCache() {
  const now = Date.now();
  for (const [k, v] of _screenshotCache) {
    if (now - v.ts > SCREENSHOT_MAX_AGE_MS) _screenshotCache.delete(k);
  }
}
setInterval(gcScreenshotCache, 5 * 60 * 1000).unref?.();

// ── 인증 미들웨어 (대시보드용) ──
function requireAuth(req, res, next) {
  const token = req.cookies?.ms_token;
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Session expired" });
  }
}

// ── 클라이언트(Electron) owner/token 검증 ──
function verifyClient(owner, token) {
  if (!owner || !token) return false;
  const row = db.get("SELECT token FROM clients WHERE owner=?", [owner])
           || db.get("SELECT token FROM tokens  WHERE owner=?", [owner]);
  return !!(row && row.token === token);
}

// req.ip는 trust proxy=1 덕분에 X-Forwarded-For 첫 IP 반환.
// IPv6-mapped IPv4 정규화(::ffff:1.2.3.4 → 1.2.3.4).
function extractIp(req) {
  let ip = (req.ip || req.headers["x-forwarded-for"] || req.connection?.remoteAddress || "").toString();
  if (ip.includes(",")) ip = ip.split(",")[0].trim();
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  return ip;
}

function upsertPc(pc_id, ip) {
  const now = Date.now();
  const existing = db.get("SELECT pc_id FROM pcs WHERE pc_id=?", [pc_id]);
  if (existing) {
    db.run("UPDATE pcs SET ip=?, last_seen=? WHERE pc_id=?", [ip, now, pc_id]);
  } else {
    db.run(
      "INSERT INTO pcs (pc_id, name, ip, first_seen, last_seen, last_screenshot) VALUES (?,?,?,?,?,?)",
      [pc_id, "", ip, now, now, 0]
    );
  }
  return now;
}

// ════════════════════════════════════════════════════════════════════
// CLIENT — register
// ════════════════════════════════════════════════════════════════════
router.post("/register", (req, res) => {
  const { pc_id, owner, token } = req.body || {};
  if (!pc_id) return res.status(400).json({ error: "pc_id required" });
  if (!verifyClient(owner, token)) return res.status(401).json({ error: "Invalid owner/token" });

  const ip = extractIp(req);
  const now = upsertPc(pc_id, ip);
  return res.json({ ok: true, pc_id, ip, last_seen: now });
});

// ════════════════════════════════════════════════════════════════════
// CLIENT — heartbeat
// ════════════════════════════════════════════════════════════════════
router.post("/heartbeat", (req, res) => {
  const { pc_id, owner, token } = req.body || {};
  if (!pc_id) return res.status(400).json({ error: "pc_id required" });
  if (!verifyClient(owner, token)) return res.status(401).json({ error: "Invalid owner/token" });

  const ip = extractIp(req);
  const now = upsertPc(pc_id, ip);
  return res.json({ ok: true, pc_id, ip, last_seen: now });
});

// ════════════════════════════════════════════════════════════════════
// CLIENT — screenshot 업로드 (JPEG base64)
// ════════════════════════════════════════════════════════════════════
router.post("/screenshot", (req, res) => {
  const { pc_id, owner, token, image_b64, mime } = req.body || {};
  if (!pc_id || !image_b64) return res.status(400).json({ error: "pc_id and image_b64 required" });
  if (!verifyClient(owner, token)) return res.status(401).json({ error: "Invalid owner/token" });

  let buf;
  try {
    // data URL 형태("data:image/jpeg;base64,...") 또는 순수 base64 모두 허용
    const b64 = image_b64.startsWith("data:") ? image_b64.split(",", 2)[1] : image_b64;
    buf = Buffer.from(b64, "base64");
  } catch (e) {
    return res.status(400).json({ error: "invalid base64" });
  }
  if (!buf.length) return res.status(400).json({ error: "empty image" });
  if (buf.length > SCREENSHOT_MAX_BYTES)
    return res.status(413).json({ error: "image too large", max_bytes: SCREENSHOT_MAX_BYTES });

  const now = Date.now();
  _screenshotCache.set(pc_id, { buffer: buf, mime: mime || "image/jpeg", ts: now });
  // PC 자체가 등록되어 있지 않으면 register 효과까지 같이.
  const ip = extractIp(req);
  upsertPc(pc_id, ip);
  db.run("UPDATE pcs SET last_screenshot=? WHERE pc_id=?", [now, pc_id]);

  return res.json({ ok: true, pc_id, bytes: buf.length, ts: now });
});

// ════════════════════════════════════════════════════════════════════
// DASHBOARD — list (카드 데이터 + 봇 매핑)
// ════════════════════════════════════════════════════════════════════
router.get("/list", requireAuth, (req, res) => {
  const now = Date.now();

  const pcs = db.all(
    "SELECT pc_id, name, ip, first_seen, last_seen, last_screenshot FROM pcs ORDER BY last_seen DESC"
  );

  // bot_pc_tags + heartbeats(level/last_seen) 합쳐서 PC 이름별 봇 목록 구성
  const tagRows = db.all(`
    SELECT t.ign, t.pc_tag, h.owner, h.level, h.last_seen, h.channel, h.map_id
    FROM bot_pc_tags t
    LEFT JOIN heartbeats h ON h.ign = t.ign
  `);
  const botsByTag = new Map();  // key: pc_tag(trimmed, case-sensitive), value: bot[]
  for (const r of tagRows) {
    const tag = (r.pc_tag || "").trim();
    if (!tag) continue;
    if (!botsByTag.has(tag)) botsByTag.set(tag, []);
    botsByTag.get(tag).push({
      ign:       r.ign,
      owner:     r.owner || null,
      level:     r.level || null,
      last_seen: r.last_seen || null,
      online:    r.last_seen ? (now - r.last_seen) < 120_000 : false,
      channel:   r.channel ?? null,
      map_id:    r.map_id ?? null,
    });
  }

  // IP 중복 집계
  const ipCount = new Map();
  for (const p of pcs) {
    if (!p.ip) continue;
    ipCount.set(p.ip, (ipCount.get(p.ip) || 0) + 1);
  }

  const out = pcs.map(p => {
    const tagKey = (p.name || "").trim();
    const bots   = tagKey ? (botsByTag.get(tagKey) || []) : [];
    const offlineMs = now - (p.last_seen || 0);
    return {
      pc_id:           p.pc_id,
      name:            p.name || "",
      ip:              p.ip || "",
      first_seen:      p.first_seen,
      last_seen:       p.last_seen,
      last_screenshot: p.last_screenshot || 0,
      online:          offlineMs < OFFLINE_THRESHOLD_MS,
      offline_ms:      offlineMs,
      ip_duplicate:    p.ip ? (ipCount.get(p.ip) || 0) > 1 : false,
      has_screenshot:  _screenshotCache.has(p.pc_id),
      bots,
    };
  });

  return res.json({
    pcs: out,
    offline_threshold_ms: OFFLINE_THRESHOLD_MS,
  });
});

// ════════════════════════════════════════════════════════════════════
// DASHBOARD — PC name 수정
// ════════════════════════════════════════════════════════════════════
router.patch("/:pc_id", requireAuth, (req, res) => {
  const { pc_id } = req.params;
  const name = (req.body?.name ?? "").toString().trim().slice(0, 64);
  const row = db.get("SELECT pc_id FROM pcs WHERE pc_id=?", [pc_id]);
  if (!row) return res.status(404).json({ error: "pc not found" });
  db.run("UPDATE pcs SET name=? WHERE pc_id=?", [name, pc_id]);
  return res.json({ ok: true, pc_id, name });
});

// ════════════════════════════════════════════════════════════════════
// DASHBOARD — PC 카드 삭제 (스크린샷 캐시도 함께 비움)
// ════════════════════════════════════════════════════════════════════
router.delete("/:pc_id", requireAuth, (req, res) => {
  const { pc_id } = req.params;
  db.run("DELETE FROM pcs WHERE pc_id=?", [pc_id]);
  _screenshotCache.delete(pc_id);
  return res.json({ ok: true, pc_id, deleted: true });
});

// ════════════════════════════════════════════════════════════════════
// DASHBOARD — 스크린샷 바이너리
// ════════════════════════════════════════════════════════════════════
router.get("/screenshot/:pc_id", requireAuth, (req, res) => {
  const { pc_id } = req.params;
  const entry = _screenshotCache.get(pc_id);
  if (!entry) return res.status(404).end();
  res.setHeader("Content-Type", entry.mime || "image/jpeg");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Screenshot-Ts", String(entry.ts));
  return res.end(entry.buffer);
});

module.exports = router;
