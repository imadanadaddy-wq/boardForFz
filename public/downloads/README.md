# downloads

웹 대시보드(PC Status 탭 → "📦 파일 다운로드")에서 직접 업로드/삭제하는 파일 저장소입니다.
별도 코드 수정이나 GitHub 푸시 없이 브라우저에서 .bat/.exe 등을 올리면 다운로드 카드가 자동 생성됩니다.

## 영구 저장 (Railway)
재배포 시 파일이 사라지지 않게 하려면 Volume 을 마운트하세요.
- Variables : UPLOAD_DIR = /data/downloads
- Volumes   : Mount path = /data

UPLOAD_DIR 미설정 시 이 폴더(public/downloads)에 저장되며, 재배포 시 git 에 없는 업로드분은 소실됩니다.

## 허용 확장자 / 제한
.bat .exe .cmd .ps1 .zip .lua .txt .msi · 파일당 최대 300MB
업로드·삭제는 로그인(Discord OAuth) 필요, 목록·다운로드는 공개.
