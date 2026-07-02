const express    = require("express");
const router     = express.Router();
const jwt        = require("jsonwebtoken");
const db         = require("../db");
const JWT_SECRET = process.env.JWT_SECRET || "change-this-secret-in-production";

// 메소 저하 알람 (기존 웹훅 유지)
const DISCORD_WEBHOOK_MESO  = "https://discord.com/api/webhooks/1503065555022774273/BtJoqbrGR1ym4ZgYKf5usuuqSbTfnSggzfTO2M9b0wSGuTdMUBBhLI1cEi2xZKCU7ad8";
// 오프라인 알람 (NEW: 별도 채널로 분리)
const DISCORD_WEBHOOK_OFF   = "https://discord.com/api/webhooks/1518265446699106326/RxQjVxU-DR1GC5a6es3DxPZK9_Y6Dwu4TqLvQk4ZVJ5GMAlBCbeRQ1LMTVxLtfLl3wr7";
// 소비아이템 재고 알람 (fuel / ale / wap / charm / petfeed)
const DISCORD_WEBHOOK_STOCK = "https://discord.com/api/webhooks/1518265050073399420/N47RoIN0IbuY6XNbPYu5KpMdRl3s55kgs7pc6rDjHcGQ1qNgsL0rvh7U7Y_pECNyhWPi";

// 관리 대상 아이템 5종 메타 (기본 임계값 + 라벨). 실제 enabled/threshold는 봇별 bot_item_config.
// WAP은 환산(2003611 + 2003551×4)이라 id 필드 없음.
const ITEM_META = {
  fuel:    { defThreshold: 50,    label: "Fuel",    ids: [2000039] },
  ale:     { defThreshold: 10000, label: "Ale",     ids: [2002023] },
  wap:     { defThreshold: 50,    label: "WAP",  ids: null },     // 환산 전용
  charm:   { defThreshold: 2,     label: "Charm", ids: [5130000] },
  petfeed: { defThreshold: 5000,  label: "Pet food",  ids: [2120000] },
};
const ITEM_KEYS = Object.keys(ITEM_META);
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

async function sendDiscord(embeds, webhook = DISCORD_WEBHOOK_MESO) {
  try {
    const res = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds })
    });
    if (!res.ok) console.error("[management] Discord webhook 오류:", res.status, await res.text());
  } catch(e) {
    console.error("[management] Discord webhook 전송 실패:", e.message);
  }
}

// ── 재고 매칭 헬퍼 (index.html과 동일 규칙) ──────────────────
// items: [{name, count}, ...]  (private_data.items JSON)
function parseItems(itemsJson) {
  try {
    const arr = typeof itemsJson === "string" ? JSON.parse(itemsJson) : itemsJson;
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
function itemCountByName(items, keyword, ...excludes) {
  const it = items.find(x => x.name && x.name.includes(keyword)
    && !excludes.some(ex => x.name.includes(ex)));
  return it ? (it.count || 0) : 0;
}
function itemCountById(items, id) {
  const sid = String(id);
  const it = items.find(x =>
    String(x.id) === sid || String(x.item_id) === sid ||
    (x.name && x.name.includes(sid))
  );
  return it ? (it.count || 0) : 0;
}
// 재고 5종 수량 산출
function getStockCounts(items) {
  // fuel: item id 2000039 우선, 없으면 이름 "연료"(에센스 제외) 폴백
  let fuelCount = itemCountById(items, 2000039);
  if (fuelCount === 0) fuelCount = itemCountByName(items, "연료", "에센스");
  // ale: item id 2002023 우선, 없으면 이름 "ale" 폴백
  let aleCount = itemCountById(items, 2002023);
  if (aleCount === 0) aleCount = itemCountByName(items, "ale");
  return {
    fuel: fuelCount,
    ale:  aleCount,
    // WAP 환산: 30분(2003611) + 2시간(2003551)x4  ★기존 로직 그대로
    wap:  itemCountById(items, 2003611) + itemCountById(items, 2003551) * 4,
    charm:   itemCountById(items, 5130000),
    petfeed: itemCountById(items, 2120000),
  };
}

// 전역 임계값 조회 → { fuel:50, ale:10000, ... } (없으면 기본값)
function getThresholds() {
  const th = {};
  for (const k of ITEM_KEYS) th[k] = ITEM_META[k].defThreshold;
  try {
    const rows = db.all("SELECT item_key, threshold FROM item_threshold");
    for (const r of rows) if (th[r.item_key] !== undefined) th[r.item_key] = r.threshold;
  } catch (e) {}
  return th;
}

// 봇별 관리 on/off 조회 → { fuel:true, ale:false, ... } (없으면 전부 false)
function getBotEnabled(ign) {
  const en = {};
  for (const k of ITEM_KEYS) en[k] = false;
  try {
    const rows = db.all("SELECT item_key, enabled FROM bot_item_config WHERE ign=?", [ign]);
    for (const r of rows) if (en[r.item_key] !== undefined) en[r.item_key] = !!r.enabled;
  } catch (e) {}
  return en;
}

function checkMesoAlert(owner, ign, level, meso_hr, isOnline) {
  const key = `${owner}|${ign}`;
  const now = Date.now();

  if (!isOnline) {
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
          }], DISCORD_WEBHOOK_OFF);
        }
        continue;
      }

      // 2) 오프라인 봇 처리
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
      }], DISCORD_WEBHOOK_OFF);

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
// NEW: 소비아이템 재고 감시 (fuel / WAP / white elixir)
//   - 봇별, active_bots 등록 봇만, 온라인 봇만 대상
//   - 임계 미만 → 1회만 알람(STOCK 웹훅), 회복되면 해소 알람
// ═══════════════════════════════════════════════════════════════
const stockAlertSent = new Map();  // key: "owner|ign|type" -> { count, alertedAt }
const STOCK_CHECK_INTERVAL = 30 * 60 * 1000;  // 30분마다

function checkStock() {
  const now = Date.now();
  if (now - serverBootTime < OFFLINE_GRACE_AFTER_BOOT) return;

  try {
    // private_data + heartbeats(온라인 판정)
    const rows = db.all(`
      SELECT p.owner, p.ign, p.level, p.items, h.last_seen
      FROM private_data p
      LEFT JOIN heartbeats h ON h.owner = p.owner AND h.ign = p.ign
    `);

    for (const row of rows) {
      const botKey = `${row.owner}|${row.ign}`;
      const online = row.last_seen && (now - row.last_seen < OFFLINE_THRESHOLD_MS);

      // active_bots 등록 + 온라인만 대상
      const eligible = isActiveBot(row.ign) && online;

      const items  = parseItems(row.items);
      const counts = getStockCounts(items);
      const enabled = getBotEnabled(row.ign);
      const thresholds = getThresholds();

      for (const type of ITEM_KEYS) {
        const key   = `${botKey}|${type}`;
        const meta  = ITEM_META[type];
        const count = counts[type] || 0;

        // 관리 대상 아님(봇별 체크 해제) 또는 오프라인/비활성 → 발송상태만 정리
        if (!eligible || !enabled[type]) { stockAlertSent.delete(key); continue; }

        const min = thresholds[type];
        if (count < min) {
          // 부족 — 아직 알람 안 보냈으면 1회 발송
          if (!stockAlertSent.has(key)) {
            stockAlertSent.set(key, { count, alertedAt: now });
            sendDiscord([{
              color: 0xe74c3c,
              title: "📦 재고 부족 경고",
              description: `**${row.ign}** (Lv.${row.level}) — ${meta.label} 재고가 부족합니다`,
              fields: [
                { name: "현재 수량", value: `**${count.toLocaleString()}**`, inline: true },
                { name: "기준치",    value: `${min.toLocaleString()} 미만`, inline: true },
              ],
              footer: { text: "Maple Dash · Stock Monitor" },
              timestamp: new Date().toISOString()
            }], DISCORD_WEBHOOK_STOCK);
            console.log(`[STOCK-ALERT] ${row.ign} ${type} low: ${count} < ${min}`);
          }
        } else {
          // 충분 — 이전에 부족 알람 보냈으면 해소 알람 1회
          if (stockAlertSent.has(key)) {
            const prev = stockAlertSent.get(key);
            stockAlertSent.delete(key);
            sendDiscord([{
              color: 0x2ecc71,
              title: "✅ 재고 회복",
              description: `**${row.ign}** (Lv.${row.level}) — ${meta.label} 재고가 충전되었습니다`,
              fields: [
                { name: "현재 수량", value: `**${count.toLocaleString()}**`, inline: true },
                { name: "부족 지속", value: formatDur(now - prev.alertedAt), inline: true },
              ],
              footer: { text: "Maple Dash · Stock Monitor" },
              timestamp: new Date().toISOString()
            }], DISCORD_WEBHOOK_STOCK);
            console.log(`[STOCK-ALERT] ${row.ign} ${type} recovered: ${count}`);
          }
        }
      }
    }
  } catch (e) {
    console.error("[STOCK-ALERT] error:", e.message);
  }
}

setInterval(checkStock, STOCK_CHECK_INTERVAL);
console.log(`[management] Stock monitor active (items: ${ITEM_KEYS.join("/")}, check every ${STOCK_CHECK_INTERVAL/60000}min)`);

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

// ══════════════════════════════════════════════════
// 아이템 재고 테이블 API
// ══════════════════════════════════════════════════

// 아이템 메타(키/라벨/기본임계) — 프론트 헤더 구성용
router.get("/item-meta", requireAuth, (req, res) => {
  res.json(ITEM_KEYS.map(k => ({ key: k, label: ITEM_META[k].label, defThreshold: ITEM_META[k].defThreshold })));
});

// 전역 임계값 조회
router.get("/item-thresholds", requireAuth, (req, res) => {
  res.json(getThresholds());
});

// 봇별 아이템 테이블: 수량 + 봇별 enabled + (전역 임계값은 별도)
router.get("/item-table", requireAuth, (req, res) => {
  const now = Date.now();
  const actives = db.all("SELECT ign FROM active_bots ORDER BY ign");
  const thresholds = getThresholds();
  const out = [];
  for (const { ign } of actives) {
    const pd = db.get("SELECT owner, ign, level, items, last_seen FROM private_data WHERE ign=?", [ign]);
    const hb = db.get("SELECT last_seen FROM heartbeats WHERE ign=?", [ign]);
    const items  = pd ? parseItems(pd.items) : [];
    const counts = getStockCounts(items);
    const enabled = getBotEnabled(ign);
    const lastSeen = hb?.last_seen || pd?.last_seen || 0;
    out.push({
      ign,
      level:  pd?.level || 0,
      online: lastSeen && (now - lastSeen < OFFLINE_THRESHOLD_MS),
      counts,       // { fuel, ale, wap, charm, petfeed }
      enabled,      // { fuel:true, ale:false, ... } (봇별)
    });
  }
  res.json({ rows: out, thresholds });   // 전역 임계값 동봉
});

// 봇별 관리 on/off 저장: { ign, item_key, enabled }
router.put("/item-config", requireAuth, express.json(), (req, res) => {
  const { ign, item_key, enabled } = req.body || {};
  if (!ign || !ITEM_KEYS.includes(item_key))
    return res.status(400).json({ error: "ign, valid item_key required" });
  const en = enabled ? 1 : 0;
  db.run(
    `INSERT INTO bot_item_config (ign, item_key, enabled) VALUES (?,?,?)
     ON CONFLICT(ign, item_key) DO UPDATE SET enabled=excluded.enabled`,
    [ign, item_key, en]
  );
  res.json({ ok: true, ign, item_key, enabled: !!en });
});

// 전역 임계값 저장 (헤더에서 조정, 모든 봇 공통): { item_key, threshold }
router.put("/item-threshold", requireAuth, express.json(), (req, res) => {
  const { item_key, threshold } = req.body || {};
  if (!ITEM_KEYS.includes(item_key))
    return res.status(400).json({ error: "valid item_key required" });
  const th = Math.max(0, parseInt(threshold, 10) || 0);
  db.run(
    `INSERT INTO item_threshold (item_key, threshold) VALUES (?,?)
     ON CONFLICT(item_key) DO UPDATE SET threshold=excluded.threshold`,
    [item_key, th]
  );
  res.json({ ok: true, item_key, threshold: th });
});

module.exports = { router, checkMesoAlert };
