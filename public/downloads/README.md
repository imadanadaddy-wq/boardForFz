# Maple Overlay Builds

여기에 .exe 파일을 두면 dash의 🖥️ PC Status 탭 상단에
자동으로 다운로드 카드가 표시됩니다.

빌드 결과물 위치:
  boardForFz-main/dist-electron/MapleOverlay-Portable-1.0.0.exe
  boardForFz-main/dist-electron/Maple Overlay Setup 1.0.0.exe

이 두 파일을 `public/downloads/` 폴더에 복사한 뒤 git push 하면
Railway에서 자동 서빙됩니다.

큰 파일(>100MB)이면 git LFS 또는 GitHub Releases 사용을 권장.
GitHub Releases에 올린 경우 Railway 환경변수로:
  DOWNLOAD_REDIRECT_BASE=https://github.com/<user>/<repo>/releases/download/<tag>
설정하면 자동으로 redirect됩니다.

분류:
  파일명에 "portable" 포함 → 💾 Portable 카드로 표시
  그 외 → 🔧 Installer 카드로 표시
