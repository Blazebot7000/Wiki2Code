const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('wiki2code', {
  desktop: true,
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
});
