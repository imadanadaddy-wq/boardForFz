const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const Store = require('electron-store');
const pcClient = require('./pc-client');

const store = new Store();

let overlayWin = null;
let tray = null;

function createOverlayWindow() {
  const { width } = screen.getPrimaryDisplay().workAreaSize;

  const savedX = store.get('winX', width - 330);
  const savedY = store.get('winY', 80);

  // 패키징 후엔 resourcesPath/build/icon.ico, dev에선 build/icon.ico 둘 다 시도
  const iconPath = path.join(__dirname, 'build', 'icon.ico');
  let trayIconImg = nativeImage.createFromPath(iconPath);
  if (trayIconImg.isEmpty()) {
    const alt = path.join(process.resourcesPath || '', 'build', 'icon.ico');
    trayIconImg = nativeImage.createFromPath(alt);
  }

  overlayWin = new BrowserWindow({
    x: savedX,
    y: savedY,
    width: 310,
    height: 480,
    minWidth: 260,
    minHeight: 200,
    icon: iconPath,
    frame: false,
    transparent: true,
    alwaysOnTop: true,       // ★ 항상 최상위
    resizable: true,
    skipTaskbar: false,
    hasShadow: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  // ★ 게임(보더리스/창모드) 위에도 뜨는 레벨
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.setVisibleOnAllWorkspaces(true);

  overlayWin.loadFile(path.join(__dirname, 'overlay.html'));

  overlayWin.on('moved', () => {
    const [x, y] = overlayWin.getPosition();
    store.set('winX', x);
    store.set('winY', y);
  });

  overlayWin.on('closed', () => { overlayWin = null; });

  // 트레이가 createTray()에서 빈 아이콘을 쓰고 있으면 여기서 다시 입혀줌
  if (tray && !trayIconImg.isEmpty()) {
    try { tray.setImage(trayIconImg.resize({ width: 16, height: 16 })); } catch(e){}
  }
}

function createTray() {
  // 아이콘은 createOverlayWindow에서 setImage로 덮어쓰지만, 트레이 자체는 먼저 만들어둠.
  const iconPath = path.join(__dirname, 'build', 'icon.ico');
  let img = nativeImage.createFromPath(iconPath);
  if (img.isEmpty()) {
    const alt = path.join(process.resourcesPath || '', 'build', 'icon.ico');
    img = nativeImage.createFromPath(alt);
  }
  if (img.isEmpty()) img = nativeImage.createEmpty();
  else img = img.resize({ width: 16, height: 16 });
  tray = new Tray(img);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '오버레이 보이기/숨기기',
      click: () => {
        if (!overlayWin) return;
        overlayWin.isVisible() ? overlayWin.hide() : overlayWin.show();
      }
    },
    {
      label: '항상 위 고정',
      type: 'checkbox',
      checked: true,
      click: (item) => {
        if (!overlayWin) return;
        overlayWin.setAlwaysOnTop(item.checked, item.checked ? 'screen-saver' : 'normal');
      }
    },
    { type: 'separator' },
    {
      label: 'API 주소 설정',
      click: () => overlayWin && overlayWin.webContents.send('open-settings')
    },
    { type: 'separator' },
    { label: '종료', click: () => app.quit() }
  ]);

  tray.setToolTip('Maple Overlay');
  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => {
    if (!overlayWin) return;
    overlayWin.isVisible() ? overlayWin.hide() : overlayWin.show();
  });
}

// IPC handlers
ipcMain.on('window-move', (e, { dx, dy }) => {
  if (!overlayWin) return;
  const [x, y] = overlayWin.getPosition();
  overlayWin.setPosition(x + dx, y + dy);
});
ipcMain.on('window-hide',   () => overlayWin && overlayWin.hide());
ipcMain.on('set-opacity',   (e, val) => overlayWin && overlayWin.setOpacity(val));

ipcMain.handle('get-config', () => ({
  apiUrl:   store.get('apiUrl',   'https://hyeongfz.up.railway.app/api/bot-heartbeat/client'),
  interval: store.get('interval', 10000),
  opacity:  store.get('opacity',  93),
  // PC 관리용
  pcApiBase: store.get('pcApiBase', 'https://hyeongfz.up.railway.app'),
  pcOwner:   store.get('pcOwner',   'Hyeong'),
  pcToken:   store.get('pcToken',   'b4e8a2f1c9d3705e6b2c4a8f1d5e9a7c3b6e2f4d8a0c5e1b9f3a7c2d6e4b8f0'),
  pcId:      pcClient.getPcId() || null,
}));
ipcMain.handle('save-config', (e, cfg) => {
  store.set('apiUrl',   cfg.apiUrl);
  store.set('interval', cfg.interval);
  store.set('opacity',  cfg.opacity);
  if (cfg.pcApiBase !== undefined) store.set('pcApiBase', cfg.pcApiBase);
  if (cfg.pcOwner   !== undefined) store.set('pcOwner',   cfg.pcOwner);
  if (cfg.pcToken   !== undefined) store.set('pcToken',   cfg.pcToken);
  // 설정 변경 시 pc-client에 즉시 반영
  pcClient.updateConfig({
    apiBase: store.get('pcApiBase'),
    owner:   store.get('pcOwner'),
    token:   store.get('pcToken'),
  });
  return true;
});

app.whenReady().then(() => {
  createOverlayWindow();
  createTray();
  // PC 카드 시스템 클라이언트 시작
  pcClient.start(store, {
    apiBase: store.get('pcApiBase', 'https://hyeongfz.up.railway.app'),
    owner:   store.get('pcOwner',   'Hyeong'),
    token:   store.get('pcToken',   'b4e8a2f1c9d3705e6b2c4a8f1d5e9a7c3b6e2f4d8a0c5e1b9f3a7c2d6e4b8f0'),
  });
  app.on('activate', () => { if (!overlayWin) createOverlayWindow(); });
});

app.on('before-quit', () => { try { pcClient.stop(); } catch(e){} });

// 창 닫아도 트레이 상주 유지 (종료는 트레이 메뉴 사용)
app.on('window-all-closed', () => {});
