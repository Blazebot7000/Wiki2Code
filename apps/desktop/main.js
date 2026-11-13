const { app, BrowserWindow, Menu, shell } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..', '..');
const GATEWAY_URL = process.env.WIKI2CODE_GATEWAY_URL ?? 'http://127.0.0.1:3000';
const DEV_URL = process.env.WIKI2CODE_DEV_URL;
const USE_EXTERNAL_SERVICES = process.env.WIKI2CODE_EXTERNAL_SERVICES === '1';

// Keep Chromium's profile out of the default "Electron" folder and out of the
// service data folder (%APPDATA%\Wiki2Code), which holds repos and secrets.
app.setName('Wiki2Code');
app.setPath('userData', path.join(app.getPath('appData'), 'Wiki2Code', 'electron'));

const SERVICES = [
  { name: 'github-svc', port: 4001 },
  { name: 'ai-svc', port: 4002 },
  { name: 'review-svc', port: 4003 },
  { name: 'sync-svc', port: 4004 },
  { name: 'gateway', port: 3000 },
];

const children = new Map();
let mainWindow = null;
let shuttingDown = false;

function startServices() {
  if (USE_EXTERNAL_SERVICES) {
    console.log('[desktop] using externally managed services');
    return;
  }

  for (const service of SERVICES) {
    const entry = path.join(ROOT, 'apps', service.name, 'dist', 'main.js');
    if (!fs.existsSync(entry)) {
      throw new Error(
        `Missing build for ${service.name} (${entry}). Run "npm run build" first.`,
      );
    }

    const child = spawn(process.execPath, [entry], {
      cwd: ROOT,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const prefix = `[${service.name}]`;
    const forward = (stream, target) => {
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        for (const line of String(chunk).split(/\r?\n/)) {
          if (line.trim()) {
            target.write(`${prefix} ${line}\n`);
          }
        }
      });
    };
    forward(child.stdout, process.stdout);
    forward(child.stderr, process.stderr);

    child.on('exit', (code) => {
      children.delete(service.name);
      if (!shuttingDown) {
        console.error(`${prefix} exited with code ${code}`);
      }
    });

    children.set(service.name, child);
  }
}

async function waitForGateway(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${GATEWAY_URL}/api/setup`);
      if (response.ok) {
        return true;
      }
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

function stopServices() {
  shuttingDown = true;
  for (const child of children.values()) {
    try {
      child.kill();
    } catch {
      // already gone
    }
  }
  children.clear();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 1080,
    minHeight: 680,
    backgroundColor: '#0a0d13',
    show: false,
    autoHideMenuBar: true,
    title: 'Wiki2Code',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = [GATEWAY_URL, DEV_URL].filter(Boolean);
    if (!allowed.some((base) => url.startsWith(base))) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  // The app hides Electron's menu bar, so without this the webview has no
  // context menu at all and fields feel like right-click is blocked.
  mainWindow.webContents.on('context-menu', (_event, params) => {
    const flags = params.editFlags;
    const template = [];
    if (params.isEditable) {
      template.push(
        { label: 'Undo', role: 'undo', enabled: flags.canUndo },
        { label: 'Redo', role: 'redo', enabled: flags.canRedo },
        { type: 'separator' },
        { label: 'Cut', role: 'cut', enabled: flags.canCut },
        { label: 'Copy', role: 'copy', enabled: flags.canCopy },
        { label: 'Paste', role: 'paste', enabled: flags.canPaste },
        { type: 'separator' },
        { label: 'Select all', role: 'selectAll', enabled: flags.canSelectAll },
      );
    } else if (params.selectionText.trim()) {
      template.push(
        { label: 'Copy', role: 'copy', enabled: flags.canCopy },
        { type: 'separator' },
        { label: 'Select all', role: 'selectAll' },
      );
    } else {
      return;
    }
    Menu.buildFromTemplate(template).popup({ window: mainWindow });
  });

  if (DEV_URL) {
    void mainWindow.loadURL(DEV_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    void mainWindow.loadURL(`${GATEWAY_URL}/`);
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

async function bootstrap() {
  Menu.setApplicationMenu(null);
  startServices();

  const ready = await waitForGateway();
  if (!ready) {
    console.error('[desktop] gateway did not become ready in time');
  }

  createWindow();
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();
    }
  });

  app.whenReady().then(bootstrap).catch((error) => {
    console.error('[desktop] failed to start:', error);
    app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('before-quit', stopServices);
  app.on('will-quit', stopServices);
  process.on('exit', stopServices);
}
