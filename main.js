const { app, BrowserWindow, BrowserView, ipcMain, Menu } = require('electron');
const path = require('path');

const MOODLE_URL = 'https://moodle.scd.edu.om';
const TOOLBAR_HEIGHT = 44;

let mainWindow = null;
let toolbarView = null;
let moodleView = null;

// ── Session partition (non-persistent = incognito) ────────────────────────────
function getIncognitoSession() {
  const { session } = require('electron');
  return session.fromPartition('incognito', { cache: false });
}

// ── Layout helper ─────────────────────────────────────────────────────────────
function layout() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const [width, height] = mainWindow.getContentSize();

  toolbarView.setBounds({ x: 0, y: 0, width, height: TOOLBAR_HEIGHT });
  moodleView.setBounds({ x: 0, y: TOOLBAR_HEIGHT, width, height: height - TOOLBAR_HEIGHT });
}

// ── App ready ─────────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  const incognito = getIncognitoSession();

  Menu.setApplicationMenu(buildMenu());

  // ── Main window ───────────────────────────────────────────────────────────
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 600,
    minHeight: 400,
    title: 'SCD Moodle',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // ── Toolbar BrowserView ───────────────────────────────────────────────────
  toolbarView = new BrowserView({
    webPreferences: {
      preload: path.join(__dirname, 'src', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  mainWindow.addBrowserView(toolbarView);
  toolbarView.webContents.loadFile(path.join(__dirname, 'src', 'toolbar.html'));

  // ── Moodle BrowserView (incognito) ────────────────────────────────────────
  moodleView = new BrowserView({
    webPreferences: {
      session: incognito,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  mainWindow.addBrowserView(moodleView);
  moodleView.webContents.loadURL(MOODLE_URL);

  // Initial layout
  layout();

  // Route all new-window / target=_blank links back into moodleView
  moodleView.webContents.setWindowOpenHandler(({ url }) => {
    moodleView.webContents.loadURL(url);
    return { action: 'deny' };
  });

  // ── Loading state + can-go-back → toolbar ─────────────────────────────────
  function sendLoading(isLoading) {
    if (!toolbarView.webContents.isDestroyed()) {
      toolbarView.webContents.send('loading-state', isLoading);
    }
  }

  function sendCanGoBack() {
    if (!toolbarView.webContents.isDestroyed()) {
      toolbarView.webContents.send('can-go-back', moodleView.webContents.canGoBack());
    }
  }

  moodleView.webContents.on('did-start-loading', () => sendLoading(true));
  moodleView.webContents.on('did-stop-loading', () => {
    sendLoading(false);
    sendCanGoBack();
  });
  moodleView.webContents.on('did-navigate', sendCanGoBack);
  moodleView.webContents.on('did-navigate-in-page', sendCanGoBack);

  // ── IPC: toolbar buttons ──────────────────────────────────────────────────
  ipcMain.on('toolbar:refresh', () => {
    if (!moodleView.webContents.isDestroyed()) {
      moodleView.webContents.reload();
    }
  });

  ipcMain.on('toolbar:go-back', () => {
    if (!moodleView.webContents.isDestroyed() && moodleView.webContents.canGoBack()) {
      moodleView.webContents.goBack();
    }
  });

  // ── Layout on resize ──────────────────────────────────────────────────────
  mainWindow.on('resize', layout);

  // Show window once toolbar is ready (avoids white flash)
  toolbarView.webContents.once('dom-ready', () => {
    mainWindow.show();
  });

  // ── Wipe session on quit (true incognito) ─────────────────────────────────
  app.on('before-quit', async () => {
    try {
      await incognito.clearStorageData();
      await incognito.clearCache();
    } catch (_) {
      // best-effort
    }
  });

  // macOS: re-open window when dock icon clicked
  app.on('activate', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ── Application menu (F5 / Cmd+R reload) ─────────────────────────────────────
function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'View',
      submenu: [
        {
          label: 'Reload',
          accelerator: isMac ? 'Cmd+R' : 'F5',
          click() {
            if (moodleView && !moodleView.webContents.isDestroyed()) {
              moodleView.webContents.reload();
            }
          },
        },
        {
          label: 'Hard Reload',
          accelerator: isMac ? 'Cmd+Shift+R' : 'Ctrl+Shift+R',
          click() {
            if (moodleView && !moodleView.webContents.isDestroyed()) {
              moodleView.webContents.reloadIgnoringCache();
            }
          },
        },
        { type: 'separator' },
        { role: 'toggleDevTools' },
      ],
    },
    { role: 'windowMenu' },
  ];
  return Menu.buildFromTemplate(template);
}
