// ════════════════════════════════════════════════════════════════════
// routes/downloads.js — 웹 업로드형 파일 배포 라우트
//
// 브라우저에서 직접 .bat/.exe 등을 업로드/삭제하고, 자동으로 다운로드 카드 생성.
// GitHub 푸시/재배포 없이 운영. 단, Railway 재배포 시 파일 유지를 위해 Volume 사용:
//   Variables :  UPLOAD_DIR = /data/downloads
//   Volumes   :  Mount path = /data
// (미설정 시 public/downloads 에 저장 → 재배포 시 git에 없는 업로드분은 소실)
//
// 마운트:  app.use("/api/downloads", require("./routes/downloads")(requireAuth));
// 라우트:
//   GET    /api/downloads/list          → 파일 목록 (공개)
//   POST   /api/downloads/upload        → 업로드 (보호, multipart field: files)
//   GET    /api/downloads/file/:name    → 다운로드 (공개)
//   DELETE /api/downloads/file/:name    → 삭제 (보호)
//
// 의존성:  npm i multer
// ════════════════════════════════════════════════════════════════════
const express = require("express");
const multer  = require("multer");
const fs      = require("fs");
const path    = require("path");

const UPLOAD_DIR = process.env.UPLOAD_DIR
  || path.join(__dirname, "..", "public", "downloads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOW_EXT = [".bat", ".exe", ".cmd", ".ps1", ".zip", ".lua", ".txt", ".msi"];
const MAX_SIZE  = 300 * 1024 * 1024; // 300MB

// 파일명 정리(경로 조작 방지, 한글 허용)
const safeName = (name) =>
  path.basename(name).replace(/[^\w.\-가-힣 ()]/g, "_").slice(0, 120);

// 최종 경로가 UPLOAD_DIR 밖으로 못 나가게 검증
const resolveInDir = (name) => {
  const fp = path.resolve(UPLOAD_DIR, safeName(name));
  return fp.startsWith(path.resolve(UPLOAD_DIR) + path.sep) ? fp : null;
};

// multipart 한글 파일명 깨짐 복원(latin1 → utf8)
const decodeOriginal = (s) => Buffer.from(s, "latin1").toString("utf8");

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename:    (req, file, cb) => cb(null, safeName(decodeOriginal(file.originalname))),
});
const upload = multer({
  storage,
  limits: { fileSize: MAX_SIZE },
  fileFilter: (req, file, cb) =>
    cb(null, ALLOW_EXT.includes(path.extname(decodeOriginal(file.originalname)).toLowerCase())),
});

// requireAuth 를 주입받는 팩토리 (server.js 의 JWT 미들웨어 재사용)
module.exports = (requireAuth) => {
  const router = express.Router();
  const guard  = typeof requireAuth === "function" ? requireAuth : (q, s, n) => n();

  // 목록 (공개) — 기존 프론트 호환 위해 { builds } 래핑
  router.get("/list", (req, res) => {
    let builds = [];
    try {
      builds = fs.readdirSync(UPLOAD_DIR)
        .filter((f) => !f.startsWith(".") && f.toLowerCase() !== "readme.md")
        .map((f) => {
          const st = fs.statSync(path.join(UPLOAD_DIR, f));
          return {
            name:  f,
            size:  st.size,
            mtime: st.mtime.getTime(),
            kind:  path.extname(f).toLowerCase().replace(".", ""),
            url:   `/api/downloads/file/${encodeURIComponent(f)}`,
          };
        })
        .sort((a, b) => b.mtime - a.mtime);
    } catch (_) {}
    res.json({ builds, count: builds.length });
  });

  // 업로드 (보호) — 다중 파일
  router.post("/upload", guard, upload.array("files", 20), (req, res) => {
    res.json({ ok: true, count: (req.files || []).length });
  });

  // 다운로드 (공개)
  router.get("/file/:name", (req, res) => {
    const fp = resolveInDir(req.params.name);
    if (!fp || !fs.existsSync(fp)) return res.status(404).send("not found");
    res.download(fp, path.basename(fp));
  });

  // 삭제 (보호)
  router.delete("/file/:name", guard, (req, res) => {
    const fp = resolveInDir(req.params.name);
    if (fp && fs.existsSync(fp)) fs.unlinkSync(fp);
    res.json({ ok: true });
  });

  return router;
};
