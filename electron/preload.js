const { ipcRenderer } = require('electron');

let dragging = false;
let lastX = 0, lastY = 0;

window.electronAPI = {
  startDrag: (x, y) => { dragging = true; lastX = x; lastY = y; },
  moveDrag:  (x, y) => {
    if (!dragging) return;
    ipcRenderer.send('window-move', { dx: x - lastX, dy: y - lastY });
    lastX = x; lastY = y;
  },
  endDrag:   () => { dragging = false; },

  hide:       () => ipcRenderer.send('window-hide'),
  setOpacity: (val) => ipcRenderer.send('set-opacity', val),

  getConfig:  () => ipcRenderer.invoke('get-config'),
  saveConfig: (cfg) => ipcRenderer.invoke('save-config', cfg),

  onOpenSettings: (cb) => ipcRenderer.on('open-settings', cb),
};
