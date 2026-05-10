const express    = require("express");
const router     = express.Router();
const jwt        = require("jsonwebtoken");
const JWT_SECRET = process.env.JWT_SECRET || "change-this-secret-in-production";

const DISCORD_WEBHOOK    = "https://discord.com/api/webhooks/1503065555022774273/BtJoqbrGR1ym4ZgYKf5usuuqSbTfnSggzfTO2M9b0wSGuTdMUBBhLI1cEi2xZKCU7ad8";
const LOW_MESO_THRESHOLD  = 150_000_000;   // 150m/hr
const ALERT_DURATION_MS   = 30 * 60 * 1000; // 30분
const MIN_LEVEL_FOR_ALERT = 260;

// ── 메소 알림 상태 (서버 메모리) ──
// { "owner|ign": { ign, owner, level, lowSince, alerted, alertTs, lastMesoHr } }
const alertStates = new Map();

// 해소 히스토리 (최대 50건)
const resolvedHistory = [];

// ─────────────────────────────────────────────
function requireAuth(req, res, next) {
  const token = req.cookies?.ms_token;
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: "Session expired" }); }
}

// ─────────────────────────────────────────────
// 유틸
// ─────────────────────────────────────────────
function formatTs(ts) {
  return new Date(ts).toLocaleString("ko-KR", {
    timeZone: "Asia/Seoul", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit"
  });
}
function formatDur(ms) {
  const m = Math.floor(ms / 60000);
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}시간 ${m % 60}분` : `${m}분`;
}
function fmtM(n) {
  if (!n) return "0";
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  return n.toLocaleString();
}

// ─────────────────────────────────────────────
// Discord 웹훅 전송
// ─────────────────────────────────────────────
async function sendDiscord(embeds) {
  try {
    const res = await fetch(DISCORD_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds })
    });
    if (!res.ok) console.error("[management] Discord webhook 오류:", res.status, await res.text());
  } catch(e) {
    console.error("[management] Discord webhook 전송 실패:", e.message);
  }
}

// ─────────────────────────────────────────────
// 핵심 로직: tracker POST마다 호출
// ─────────────────────────────────────────────
function checkMesoAlert(owner, ign, level, meso_hr, isOnline, isForcedOffline) {
  const key = `${owner}|${ign}`;
  const now = Date.now();

  // 오프라인 / 강제오프 → 모니터링 제외
  if (!isOnline || isForcedOffline) {
    const state = alertStates.get(key);
    if (state?.alerted) {
      const dur = now - state.lowSince;
      resolvedHistory.unshift({ ...state, resolvedTs: now, resolvedReason: "offline", resolvedMesoHr: meso_hr });
      if (resolvedHistory.length > 50) resolvedHistory.pop();
      sendDiscord([{
        color: 0x2ecc71,
        title: "✅ 저메소 알림 해소 (오프라인 전환)",
        description: `**${ign}** (Lv.${level}) — 봇이 오프라인으로 전환되어 모니터링을 종료합니다`,
        fields: [
          { name: "저하 시작",  value: formatTs(state.lowSince), inline: true },
          { name: "지속 시간",  value: formatDur(dur),           inline: true },
        ],
        footer: { text: "Maple Dash · Bot Management" },
        timestamp: new Date().toISOString()
      }]);
    }
    alertStates.delete(key);
    return;
  }

  // 레벨 기준 미달 → 스킵
  if (!level || level < MIN_LEVEL_FOR_ALERT) return;

  // 샘플 미확정 → 스킵
  if (meso_hr === null || meso_hr === undefined || meso_hr === 0) return;

  if (meso_hr < LOW_MESO_THRESHOLD) {
    if (!alertStates.has(key)) {
      alertStates.set(key, { ign, owner, level, lowSince: now, alerted: false, alertTs: null, lastMesoHr: meso_hr });
    } else {
      const s = alertStates.get(key);
      s.lastMesoHr = meso_hr;
      s.level      = level;
    }

    const state    = alertStates.get(key);
    const duration = now - state.lowSince;

    // 30분 경과 & 미발송 → 1회 전송
    if (duration >= ALERT_DURATION_MS && !state.alerted) {
      state.alerted = true;
      state.alertTs = now;
      sendDiscord([{
        color: 0xe74c3c,
        title: "⚠️ 저메소 경고",
        description: `**${ign}** (Lv.${level}) 의 메소/hr 이 30분 이상 저하 상태입니다`,
        fields: [
          { name: "현재 메소/hr", value: `**${fmtM(meso_hr)}/hr**`,    inline: true },
          { name: "기준치",       value: "150m/hr 미만",                inline: true },
          { name: "저하 시작",    value: formatTs(state.lowSince),      inline: false },
          { name: "지속 시간",    value: `**${formatDur(duration)}**`,  inline: true },
        ],
        footer: { text: "Maple Dash · Bot Management" },
        timestamp: new Date().toISOString()
      }]);
    }

  } else {
    // 정상 복구
    const state = alertStates.get(key);
    if (state) {
      if (state.alerted) {
        const dur = now - state.lowSince;
        resolvedHistory.unshift({ ...state, resolvedTs: now, resolvedReason: "recovered", resolvedMesoHr: meso_hr });
        if (resolvedHistory.length > 50) resolvedHistory.pop();
        sendDiscord([{
          color: 0x2ecc71,
          title: "✅ 저메소 해소",
          description: `**${ign}** (Lv.${level}) 의 메소/hr 이 정상 복구되었습니다`,
          fields: [
            { name: "복구 메소/hr", value: `**${fmtM(meso_hr)}/hr**`, inline: true },
            { name: "저하 지속",    value: `**${formatDur(dur)}**`,    inline: true },
            { name: "저하 시작",    value: formatTs(state.lowSince),   inline: true },
            { name: "복구 시각",    value: formatTs(now),              inline: true },
          ],
          footer: { text: "Maple Dash · Bot Management" },
          timestamp: new Date().toISOString()
        }]);
      }
      alertStates.delete(key);
    }
  }
}

// ─────────────────────────────────────────────
// GET /api/management/alerts
// ─────────────────────────────────────────────
router.get("/alerts", requireAuth, (req, res) => {
  const now    = Date.now();
  const active = [];
  for (const [, state] of alertStates.entries()) {
    active.push({
      ign:        state.ign,
      owner:      state.owner,
      level:      state.level,
      lowSince:   state.lowSince,
      duration:   now - state.lowSince,
      alerted:    state.alerted,
      alertTs:    state.alertTs,
      lastMesoHr: state.lastMesoHr
    });
  }
  active.sort((a, b) => b.duration - a.duration);
  res.json({ active, resolved: resolvedHistory.slice(0, 20) });
});

module.exports = { router, checkMesoAlert };
