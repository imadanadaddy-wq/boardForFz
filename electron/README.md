# 🍁 Maple Overlay — Electron 데스크톱 오버레이

메이플스토리 창모드/보더리스 게임 위에 항상 떠있는 봇 모니터링 오버레이입니다.

---

## ✅ 특징

| 기능 | 설명 |
|---|---|
| **항상 최상위** | `alwaysOnTop: screen-saver` 레벨 — 창모드/보더리스 게임 위 고정 |
| **투명 배경** | 게임 화면이 오버레이 뒤로 투과됨 |
| **드래그 이동** | 헤더 잡고 이동, 위치 자동 저장 |
| **투명도 조절** | 슬라이더 20~100% |
| **트레이 상주** | 창 닫아도 시스템 트레이에서 살아있음 |
| **설정 저장** | API URL, 갱신 주기, 위치 모두 자동 저장 |

---

## 🚀 실행 방법

### 요구사항
- [Node.js](https://nodejs.org) LTS 버전 설치

### 실행

```bash
# 이 폴더(electron/)에서
npm install
npm start
```

### API URL 설정
앱 실행 후 ⚙ 버튼 → API URL 입력

**서버 API URL 예시:**
- `http://localhost:3000/api/tracker` — 메소 트래커 (B/HR 포함)
- `http://localhost:3000/api/bot-heartbeat/client` — 하트비트 (채널/맵 포함)
- `https://your-railway-app.up.railway.app/api/tracker` — Railway 배포 서버

---

## 📦 Windows EXE 빌드

```bash
npm run build:win
# → ../dist-electron/ 폴더에 설치 파일 생성
```

---

## ⚠️ 게임 모드별 작동 여부

| 게임 모드 | 오버레이 |
|---|---|
| 창모드 / 보더리스 창모드 | ✅ 항상 표시 |
| 독점 전체화면 (Exclusive FS) | ❌ 가려질 수 있음 |

메이플스토리 → 설정 → 해상도/창모드 → **창모드 또는 보더리스** 권장
