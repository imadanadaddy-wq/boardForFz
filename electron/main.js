const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const Store = require('electron-store');

const store = new Store();

let overlayWin = null;
let tray = null;

function createOverlayWindow() {
  const { width } = screen.getPrimaryDisplay().workAreaSize;

  const savedX = store.get('winX', width - 330);
  const savedY = store.get('winY', 80);

  overlayWin = new BrowserWindow({
    x: savedX,
    y: savedY,
    width: 310,
    height: 480,
    minWidth: 260,
    minHeight: 200,
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
}

function createTray() {
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);

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
  apiUrl:   store.get('apiUrl',   'http://localhost:3000/api/bot-heartbeat/client'),
  interval: store.get('interval', 10000),
  opacity:  store.get('opacity',  93),
}));
ipcMain.handle('save-config', (e, cfg) => {
  store.set('apiUrl',   cfg.apiUrl);
  store.set('interval', cfg.interval);
  store.set('opacity',  cfg.opacity);
  return true;
});

app.whenReady().then(() => {
  createOverlayWindow();
  createTray();
  app.on('activate', () => { if (!overlayWin) createOverlayWindow(); });
});

// 창 닫아도 트레이 상주 유지 (종료는 트레이 메뉴 사용)
app.on('window-all-closed', () => {});
