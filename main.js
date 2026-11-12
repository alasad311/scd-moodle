const { app, BrowserWindow, BrowserView, ipcMain, Menu, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

// Squirrel.Windows runs the app with --squirrel-* flags during install/update/
// uninstall (to create/remove shortcuts). Quit immediately in that case.
if (require('electron-squirrel-startup')) {
  app.quit();
}

// ── GPU crash fallback ────────────────────────────────────────────────────────
// On some Windows GPU drivers Chromium 118's D3D11 backend crashes the GPU
// process as soon as a page uses CSS opacity. After 3 crashes Chromium drops
// to software rendering and Moodle becomes very slow. If we see a GPU crash,
// remember it and relaunch once using the OpenGL backend, which works there.
const GPU_FALLBACK_FLAG = path.join(app.getPath('userData'), 'gpu-fallback-gl');
const usingGpuFallback = fs.existsSync(GPU_FALLBACK_FLAG);
if (usingGpuFallback) {
  app.commandLine.appendSwitch('use-angle', 'gl');
}
app.on('child-process-gone', (_event, details) => {
  if (details.type !== 'GPU' || usingGpuFallback) return;
  if (details.reason === 'clean-exit' || details.reason === 'killed') return;
  try {
    fs.mkdirSync(path.dirname(GPU_FALLBACK_FLAG), { recursive: true });
    fs.writeFileSync(GPU_FALLBACK_FLAG, `${details.reason} ${details.exitCode}\n`);
    app.relaunch();
    app.exit(0);
  } catch (_) {
    // best-effort; Chromium will still fall back to software rendering
  }
});

// Only one instance: a second launch focuses the existing window instead of
// starting another full Chromium process tree.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

const MOODLE_URL = 'https://moodle.scd.edu.om';
const TOOLBAR_HEIGHT = 44;
const SEB_SCHEMES = ['seb:', 'sebs:'];

let mainWindow = null;
let toolbarView = null;
let moodleView = null;

// ── Session partition (non-persistent = incognito) ────────────────────────────
function getIncognitoSession() {
  const { session } = require('electron');
  // A partition without the "persist:" prefix lives in memory only, so it is
  // already incognito. Do NOT pass { cache: false }: that disables the HTTP
  // cache entirely and forces every Moodle page to re-download all its JS/CSS.
  return session.fromPartition('incognito');
}

// ── Safe Exam Browser hand-off ────────────────────────────────────────────────
function isSebUrl(url) {
  try {
    return SEB_SCHEMES.includes(new URL(url).protocol);
  } catch (_) {
    return false;
  }
}

function launchSeb(url) {
  shell.openExternal(url).catch(() => {
    dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: 'Safe Exam Browser',
      message: 'Safe Exam Browser could not be opened.',
      detail: 'Please make sure Safe Exam Browser is installed on this computer, then try again.',
    });
  });
}

// ── Auto-update from GitHub Releases ──────────────────────────────────────────
function setupAutoUpdate() {
  // Only the installed (Squirrel) build can update itself; skip in dev.
  if (!app.isPackaged || process.platform !== 'win32') return;
  try {
    const { updateElectronApp, UpdateSourceType } = require('update-electron-app');
    updateElectronApp({
      updateSource: {
        type: UpdateSourceType.ElectronPublicUpdateService,
        repo: 'alasad311/scd-moodle',
      },
      updateInterval: '1 hour',
      notifyUser: true,
    });
  } catch (err) {
    console.error('Auto-update setup failed:', err);
  }
}

// ── Layout helper ─────────────────────────────────────────────────────────────
function layout() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const [width, height] = mainWindow.getContentSize();

  toolbarView.setBounds({ x: 0, y: 0, width, height: TOOLBAR_HEIGHT });
  moodleView.setBounds({ x: 0, y: TOOLBAR_HEIGHT, width, height: height - TOOLBAR_HEIGHT });
}

// ── App ready ─────────────────────────────────────────────────────────────────
app.on('second-instance', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(() => {
  setupAutoUpdate();
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
  // (SEB links are handed to the installed Safe Exam Browser instead.)
  moodleView.webContents.setWindowOpenHandler(({ url }) => {
    if (isSebUrl(url)) {
      launchSeb(url);
    } else {
      moodleView.webContents.loadURL(url);
    }
    return { action: 'deny' };
  });

  // Moodle's "Launch Safe Exam Browser" button navigates to seb:// / sebs://.
  // Chromium can't load those schemes (ERR_UNKNOWN_URL_SCHEME), so intercept
  // the navigation in the page and any sub-frame and hand it off to SEB.
  const interceptSeb = (event, url) => {
    if (isSebUrl(url)) {
      event.preventDefault();
      launchSeb(url);
    }
  };
  moodleView.webContents.on('will-navigate', interceptSeb);
  moodleView.webContents.on('will-frame-navigate', (event) => {
    if (!event.isMainFrame) interceptSeb(event, event.url); // main frame handled by will-navigate
  });
  moodleView.webContents.on('will-redirect', interceptSeb);

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

// Quit on every platform (including macOS) when the window closes, so the
// incognito session is always wiped and the next launch starts fresh.
app.on('window-all-closed', () => {
  app.quit();
});

// ── Application menu (F5 / Cmd+R reload) ─────────────────────────────────────
function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    // macOS needs an Edit menu for Cmd+C / Cmd+V / Cmd+A to work in pages.
    ...(isMac ? [{ role: 'editMenu' }] : []),
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
