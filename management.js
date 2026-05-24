const express    = require("express");
const router     = express.Router();
const jwt        = require("jsonwebtoken");
const db         = require("../db");
const JWT_SECRET = process.env.JWT_SECRET || "change-this-secret-in-production";

const DISCORD_WEBHOOK    = "https://discord.com/api/webhooks/1503065555022774273/BtJoqbrGR1ym4ZgYKf5usuuqSbTfnSggzfTO2M9b0wSGuTdMUBBhLI1cEi2xZKCU7ad8";
const LOW_MESO_THRESHOLD  = 150_000_000;
const ALERT_DURATION_MS   = 30 * 60 * 1000;
// ★ CHANGED: 기존 MIN_LEVEL_FOR_ALERT(260) 제거 → active_bots 테이블 기반 필터로 대체
// ★ CHANGED: 기존 MIN_LEVEL_FOR_OFFLINE_ALERT(260) 제거 → 동일하게 active_bots 사용

// ★ NEW: 오프라인 전환 알람 설정
const OFFLINE_THRESHOLD_MS    = 5 * 60 * 1000;    // 5분 이상 신호 없음 → 오프라인
const OFFLINE_CHECK_INTERVAL  = 30 * 1000;        // 30초마다 검사
const OFFLINE_GRACE_AFTER_BOOT = 2 * 60 * 1000;   // 서버 부팅 후 2분간은 오프라인 알람 억제 (DB 로드 + 봇들 재신호 대기)

// 헬퍼 — ign이 active_bots에 등록되어 있는지 확인
function isActiveBot(ign) {
  try {
    return !!db.get("SELECT 1 FROM active_bots WHERE ign=?", [ign]);
  } catch { return false; }
}

const alertStates       = new Map();   // 저메소 알람
const offlineAlertSent  = new Map();   // ★ NEW: 봇별 오프라인 알람 발송 상태
                                       // key: "owner|ign", value: { lastSeenAtAlert, alertedAt }
const serverBootTime    = Date.now();

function requireAuth(req, res, next) {
  const token = req.cookies?.ms_token;
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: "Session expired" }); }
}

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

function saveResolvedLog(state, resolvedTs, resolvedReason, resolvedMesoHr) {
  try {
    db.run(
      `INSERT INTO meso_alert_log
        (owner, ign, level, low_since, resolved_ts, resolved_reason, resolved_meso_hr, alerted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [state.owner, state.ign, state.level, state.lowSince,
       resolvedTs, resolvedReason, resolvedMesoHr || 0, state.alerted ? 1 : 0]
    );
    db.run(
      `DELETE FROM meso_alert_log WHERE id NOT IN (
        SELECT id FROM meso_alert_log ORDER BY resolved_ts DESC LIMIT 100
      )`
    );
  } catch (e) {
    console.error("[management] DB 저장 오류:", e.message);
  }
}

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

function checkMesoAlert(owner, ign, level, meso_hr, isOnline, isForcedOffline) {
  const key = `${owner}|${ign}`;
  const now = Date.now();

  if (!isOnline || isForcedOffline) {
    const state = alertStates.get(key);
    if (state?.alerted) {
      const dur = now - state.lowSince;
      saveResolvedLog(state, now, "offline", meso_hr);
      sendDiscord([{
        color: 0x2ecc71,
        title: "✅ 저메소 알림 해소 (오프라인 전환)",
        description: `**${ign}** (Lv.${level}) — 봇이 오프라인으로 전환되어 모니터링을 종료합니다`,
        fields: [
          { name: "저하 시작", value: formatTs(state.lowSince), inline: true },
          { name: "지속 시간", value: formatDur(dur),           inline: true },
        ],
        footer: { text: "Maple Dash · Bot Management" },
        timestamp: new Date().toISOString()
      }]);
    }
    alertStates.delete(key);
    return;
  }

  if (!level || level < 1) return;
  // ★ CHANGED: 레벨 필터(>=260) 대신 active_bots 등록 여부로 판정
  if (!isActiveBot(ign)) return;
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

    if (duration >= ALERT_DURATION_MS && !state.alerted) {
      state.alerted = true;
      state.alertTs = now;
      sendDiscord([{
        color: 0xe74c3c,
        title: "⚠️ 저메소 경고",
        description: `**${ign}** (Lv.${level}) 의 메소/hr 이 30분 이상 저하 상태입니다`,
        fields: [
          { name: "현재 메소/hr", value: `**${fmtM(meso_hr)}/hr**`,   inline: true },
          { name: "기준치",       value: "150m/hr 미만",               inline: true },
          { name: "저하 시작",    value: formatTs(state.lowSince),     inline: false },
          { name: "지속 시간",    value: `**${formatDur(duration)}**`, inline: true },
        ],
        footer: { text: "Maple Dash · Bot Management" },
        timestamp: new Date().toISOString()
      }]);
    }

  } else {
    const state = alertStates.get(key);
    if (state) {
      if (state.alerted) {
        const dur = now - state.lowSince;
        saveResolvedLog(state, now, "recovered", meso_hr);
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

// ═══════════════════════════════════════════════════════════════
// ★ NEW: 봇 오프라인 전환 감시 (1분 이상 신호 없을 때 디스코드 알람)
// ═══════════════════════════════════════════════════════════════
function checkOfflineBots() {
  const now = Date.now();

  // 서버 부팅 직후 grace period (DB 로드, 봇들 재신호 대기)
  if (now - serverBootTime < OFFLINE_GRACE_AFTER_BOOT) return;

  try {
    // 모든 heartbeat 봇 조회
    const rows = db.all(`
      SELECT h.owner, h.ign, h.level, h.last_seen, h.channel, h.map_id
      FROM heartbeats h
      ORDER BY h.last_seen DESC
    `);

    // 강제 오프라인 봇은 알람 대상에서 제외
    const forced = new Set(
      db.all("SELECT owner, ign FROM forced_offline").map(r => r.owner + "|" + r.ign)
    );

    for (const row of rows) {
      const key  = `${row.owner}|${row.ign}`;
      const dt   = now - row.last_seen;
      const isOffline = dt >= OFFLINE_THRESHOLD_MS;

      // 1) 봇이 살아 돌아왔으면 발송 상태 리셋
      if (!isOffline) {
        if (offlineAlertSent.has(key)) {
          const prev = offlineAlertSent.get(key);
          offlineAlertSent.delete(key);
          // 복귀 알람도 함께 발송 (선택)
          sendDiscord([{
            color: 0x2ecc71,
            title: "🟢 봇 온라인 복귀",
            description: `**${row.ign}** (Lv.${row.level}) 가 다시 신호를 보내고 있습니다`,
            fields: [
              { name: "오프라인 지속", value: formatDur(now - prev.alertedAt), inline: true },
              { name: "복귀 시각",     value: formatTs(now),                    inline: true },
            ],
            footer: { text: "Maple Dash · Bot Offline Monitor" },
            timestamp: new Date().toISOString()
          }]);
        }
        continue;
      }

      // 2) 오프라인 봇 처리
      // 강제 오프라인은 알람 안 보냄 (사용자가 의도적으로 막은 봇)
      if (forced.has(key)) continue;

      // ★ CHANGED: 레벨 필터(>=260) → active_bots 등록 봇만 알람
      if (!isActiveBot(row.ign)) continue;

      // 이미 알람 보낸 봇 — 중복 발송 방지
      if (offlineAlertSent.has(key)) continue;

      // 알람 발송
      offlineAlertSent.set(key, { lastSeenAtAlert: row.last_seen, alertedAt: now });

      const pcTagRow = db.get("SELECT pc_tag FROM bot_pc_tags WHERE ign=?", [row.ign]);
      const pcTag    = pcTagRow?.pc_tag || null;

      const fields = [
        { name: "마지막 신호",   value: formatTs(row.last_seen), inline: true },
        { name: "오프라인 지속", value: formatDur(dt),           inline: true },
      ];
      if (pcTag)             fields.push({ name: "PC",      value: `🖥️ ${pcTag}`,           inline: true });
      if (row.channel != null) fields.push({ name: "채널",    value: String(row.channel),    inline: true });
      if (row.map_id  != null) fields.push({ name: "맵 ID",   value: String(row.map_id),     inline: true });

      sendDiscord([{
        color: 0xe67e22,
        title: "🔴 봇 오프라인 감지",
        description: `**${row.ign}** (Lv.${row.level}) 가 5분 이상 신호를 보내지 않습니다`,
        fields,
        footer: { text: "Maple Dash · Bot Offline Monitor" },
        timestamp: new Date().toISOString()
      }]);

      console.log(`[OFFLINE-ALERT] ${row.ign} (Lv.${row.level}) offline ${Math.floor(dt/1000)}s`);
    }
  } catch (e) {
    console.error("[OFFLINE-ALERT] error:", e.message);
  }
}

// 30초마다 오프라인 봇 검사
setInterval(checkOfflineBots, OFFLINE_CHECK_INTERVAL);
console.log(`[management] Offline monitor active (threshold=${OFFLINE_THRESHOLD_MS/1000}s, check every ${OFFLINE_CHECK_INTERVAL/1000}s)`);

// ═══════════════════════════════════════════════════════════════
// 알람 조회 API (기존 + 오프라인 상태 추가)
// ═══════════════════════════════════════════════════════════════
router.get("/alerts", requireAuth, (req, res) => {
  const now = Date.now();

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

  const rows = db.all(`SELECT * FROM meso_alert_log ORDER BY resolved_ts DESC LIMIT 50`);
  const resolved = rows.map(r => ({
    ign:            r.ign,
    owner:          r.owner,
    level:          r.level,
    lowSince:       r.low_since,
    resolvedTs:     r.resolved_ts,
    resolvedReason: r.resolved_reason,
    resolvedMesoHr: r.resolved_meso_hr,
    alerted:        r.alerted === 1,
  }));

  // ★ NEW: 현재 오프라인 알람 발송된 봇 목록
  const offlineAlerts = [];
  for (const [key, info] of offlineAlertSent.entries()) {
    const [owner, ign] = key.split("|");
    offlineAlerts.push({
      owner, ign,
      alertedAt:        info.alertedAt,
      offlineSince:     info.lastSeenAtAlert,
      offlineDuration:  now - info.lastSeenAtAlert,
    });
  }

  res.json({ active, resolved, offlineAlerts });
});

module.exports = { router, checkMesoAlert };
