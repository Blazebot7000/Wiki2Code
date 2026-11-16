const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wiki2code', {
  desktop: true,
  platform: process.platform,
  suppressNextContextMenu: () =>
    ipcRenderer.sendSync('w2c:suppress-context-menu'),
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
});
