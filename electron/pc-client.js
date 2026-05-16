// ════════════════════════════════════════════════════════════════════
// electron/pc-client.js
// PC 카드 시스템용 클라이언트:
//   - 첫 실행 시 pc_id(UUID) 생성/저장
//   - 부팅 후 register 1회 + 30초마다 heartbeat
//   - 30분마다 스크린샷(JPEG) 송출
// ════════════════════════════════════════════════════════════════════
const { desktopCapturer, screen } = require("electron");
const { randomUUID } = require("crypto");

const HEARTBEAT_INTERVAL_MS  = 30 * 1000;
const SCREENSHOT_INTERVAL_MS = 30 * 60 * 1000;   // 30분
const SCREENSHOT_JPEG_QUALITY = 60;              // 0~100
const SCREENSHOT_MAX_WIDTH    = 1280;            // 짧은 변 기준 리사이즈 안 함 — width 캡만

let _store        = null;
let _config       = null;   // { apiBase, owner, token }
let _pcId         = null;
let _hbTimer      = null;
let _shotTimer    = null;
let _stopped      = false;
let _logger       = console;

function setLogger(fn) { _logger = fn || console; }

function getPcId() {
  if (_pcId) return _pcId;
  let id = _store.get("pcId", null);
  if (!id) {
    id = randomUUID();
    _store.set("pcId", id);
  }
  _pcId = id;
  return id;
}

async function postJson(url, body) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const ok   = r.ok;
    const text = await r.text().catch(() => "");
    return { ok, status: r.status, text };
  } finally {
    clearTimeout(t);
  }
}

async function sendHeartbeat(kind /* 'register' | 'heartbeat' */) {
  if (!_config) return;
  const url = `${_config.apiBase}/api/pc/${kind}`;
  try {
    const r = await postJson(url, {
      pc_id: getPcId(),
      owner: _config.owner,
      token: _config.token,
    });
    if (!r.ok) _logger.warn?.(`[pc-client] ${kind} HTTP ${r.status} ${r.text?.slice(0, 200)}`);
    else      _logger.log?.(`[pc-client] ${kind} ok`);
  } catch (e) {
    _logger.warn?.(`[pc-client] ${kind} error:`, e.message);
  }
}

async function captureAndUpload() {
  if (!_config) return;
  try {
    const primary = screen.getPrimaryDisplay();
    const size    = primary.size; // {width, height}
    // thumbnail 사이즈를 width 기준으로 캡 (높이는 비율 유지)
    const tw = Math.min(size.width, SCREENSHOT_MAX_WIDTH);
    const th = Math.round(size.height * (tw / size.width));

    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: tw, height: th },
    });
    if (!sources.length) { _logger.warn?.("[pc-client] no screen source"); return; }

    // primary 매칭 (display_id가 있으면 비교, 아니면 첫 번째)
    let src = sources[0];
    for (const s of sources) {
      if (s.display_id && String(s.display_id) === String(primary.id)) { src = s; break; }
    }

    // nativeImage → JPEG buffer → base64
    const jpegBuf = src.thumbnail.toJPEG(SCREENSHOT_JPEG_QUALITY);
    const b64     = jpegBuf.toString("base64");

    const url = `${_config.apiBase}/api/pc/screenshot`;
    const r = await postJson(url, {
      pc_id:     getPcId(),
      owner:     _config.owner,
      token:     _config.token,
      image_b64: b64,
      mime:      "image/jpeg",
    });
    if (!r.ok) _logger.warn?.(`[pc-client] screenshot HTTP ${r.status} ${r.text?.slice(0, 200)}`);
    else      _logger.log?.(`[pc-client] screenshot ok (${jpegBuf.length} bytes)`);
  } catch (e) {
    _logger.warn?.("[pc-client] screenshot error:", e.message);
  }
}

function start(store, config) {
  _store  = store;
  _config = config;
  _stopped = false;
  getPcId();
  _logger.log?.(`[pc-client] start pc_id=${_pcId}  apiBase=${_config.apiBase}`);

  sendHeartbeat("register");
  if (_hbTimer)   clearInterval(_hbTimer);
  if (_shotTimer) clearInterval(_shotTimer);

  _hbTimer = setInterval(() => {
    if (_stopped) return;
    sendHeartbeat("heartbeat");
  }, HEARTBEAT_INTERVAL_MS);

  // 첫 스크린샷은 30초 후 1회, 그 다음부터 30분 주기
  setTimeout(captureAndUpload, 30_000);
  _shotTimer = setInterval(() => {
    if (_stopped) return;
    captureAndUpload();
  }, SCREENSHOT_INTERVAL_MS);
}

function stop() {
  _stopped = true;
  if (_hbTimer)   { clearInterval(_hbTimer);   _hbTimer = null; }
  if (_shotTimer) { clearInterval(_shotTimer); _shotTimer = null; }
}

function updateConfig(config) {
  _config = config;
}

module.exports = { start, stop, setLogger, updateConfig, getPcId: () => _pcId };
