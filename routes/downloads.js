// ════════════════════════════════════════════════════════════════════
// routes/downloads.js — Maple Overlay 빌드 다운로드 라우트
//
// 동작:
//   1) public/downloads/ 폴더에 .exe가 있으면 정적으로 서빙 (1st priority)
//   2) 없으면 환경변수 DOWNLOAD_REDIRECT_BASE를 prefix로 외부 URL 리다이렉트
//      (예: GitHub Releases 링크)
//
// 라우트:
//   GET  /api/downloads/list        → 사용 가능한 빌드 목록 JSON
//   GET  /api/downloads/file/:name  → 실제 .exe 다운로드 (브라우저 redirect)
//
// 주: 인증 안 거는 이유:
//   - GitHub Releases는 어차피 public
//   - <a href> 클릭으로 외부 redirect 가는 동안 ms_token 쿠키가 SameSite로 막혀서
//     401 → 404 GitHub 페이지로 떨어지는 문제 발생
//   - 다운로드 카드 자체는 dash UI를 거쳐서만 노출되니 실용적으로 충분히 보호됨
// ════════════════════════════════════════════════════════════════════
const express = require("express");
const router  = express.Router();
const fs      = require("fs");
const path    = require("path");

const DOWNLOADS_DIR = path.join(__dirname, "..", "public", "downloads");
const REDIRECT_BASE = process.env.DOWNLOAD_REDIRECT_BASE || "";

// 빌드 목록 (대시보드에 표시할 데이터)
function listLocalBuilds() {
  if (!fs.existsSync(DOWNLOADS_DIR)) return [];
  const out = [];
  for (const name of fs.readdirSync(DOWNLOADS_DIR)) {
    if (!name.toLowerCase().endsWith(".exe")) continue;
    const full = path.join(DOWNLOADS_DIR, name);
    const stat = fs.statSync(full);
    out.push({
      name,
      size:  stat.size,
      mtime: stat.mtime.getTime(),
      kind:  name.toLowerCase().includes("portable") ? "portable" : "installer",
      url:   `/api/downloads/file/${encodeURIComponent(name)}`,
    });
  }
  // 포터블 먼저, 그다음 알파벳 순
  out.sort((a,b) => (a.kind===b.kind ? a.name.localeCompare(b.name) : (a.kind==="portable" ? -1 : 1)));
  return out;
}

// GitHub Releases 같은 외부 호스팅용 fallback 빌드 목록
// (로컬 파일이 없고 DOWNLOAD_REDIRECT_BASE만 설정된 경우)
const REDIRECT_FALLBACK_FILES = [
  { name: "MapleOverlay-Portable-1.0.0.exe", kind: "portable",  size: 0 },
  { name: "Maple Overlay Setup 1.0.0.exe",   kind: "installer", size: 0 },
];

router.get("/list", (req, res) => {
  const local = listLocalBuilds();

  let builds = local;
  if (!builds.length && REDIRECT_BASE) {
    // 로컬에 .exe가 없지만 redirect base가 있으면 가상 목록 제공
    builds = REDIRECT_FALLBACK_FILES.map(f => ({
      name:  f.name,
      size:  f.size,
      mtime: 0,
      kind:  f.kind,
      url:   `/api/downloads/file/${encodeURIComponent(f.name)}`,
    }));
  }

  res.json({
    builds,
    redirect_base: REDIRECT_BASE || null,
    has_local:     local.length > 0,
  });
});

router.get("/file/:name", (req, res) => {
  // 경로 트래버설 방지: 슬래시·백슬래시·.. 차단
  const raw = req.params.name || "";
  if (raw.includes("/") || raw.includes("\\") || raw.includes("..")) {
    return res.status(400).send("invalid filename");
  }
  if (!raw.toLowerCase().endsWith(".exe")) {
    return res.status(400).send("only .exe allowed");
  }
  const full = path.join(DOWNLOADS_DIR, raw);
  if (!fs.existsSync(full)) {
    // 로컬에 없으면 REDIRECT_BASE로 리다이렉트 (GitHub Releases 등)
    if (REDIRECT_BASE) {
      return res.redirect(302, `${REDIRECT_BASE.replace(/\/$/, "")}/${encodeURIComponent(raw)}`);
    }
    return res.status(404).send("not found");
  }
  res.download(full, raw);
});

module.exports = router;
