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

// ── Updates from GitHub Releases ──────────────────────────────────────────────
// Windows: Squirrel downloads the new version in the background (via
//   update.electronjs.org) and we show "Restart to update" in the toolbar.
//   Squirrel reports no download percentage, so the toolbar shows an
//   indeterminate "Downloading update…" indicator instead of a progress bar.
// macOS: the build is unsigned and cannot self-update, so we only check the
//   latest GitHub release and offer a link to download it.
const REPO = 'alasad311/scd-moodle';
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;
const UPDATE_INTERVAL_MS = 60 * 60 * 1000; // Windows: hourly
const MAC_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // macOS: GitHub API is rate-limited

// state: idle | checking | downloading | ready | available | none | error | unsupported
let updateState = { state: 'idle' };
let manualCheckPending = false;

function setUpdateState(next) {
  updateState = next;
  if (toolbarView && !toolbarView.webContents.isDestroyed()) {
    toolbarView.webContents.send('update-state', updateState);
  }
  if (manualCheckPending && ['none', 'error', 'ready', 'available', 'downloading'].includes(next.state)) {
    manualCheckPending = false;
    showManualCheckResult();
  }
}

function compareVersions(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(Number);
  const pb = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

let checkForUpdates = () => {};

function setupUpdates() {
  if (!app.isPackaged) {
    updateState = { state: 'unsupported', reason: 'Development build' };
    return;
  }

  if (process.platform === 'win32') {
    const { autoUpdater } = require('electron');
    const feed = `https://update.electronjs.org/${REPO}/${process.platform}-${process.arch}/${app.getVersion()}`;
    try {
      autoUpdater.setFeedURL({ url: feed });
    } catch (err) {
      updateState = { state: 'error', message: err.message };
      return;
    }
    autoUpdater.on('checking-for-update', () => {
      if (updateState.state !== 'ready') setUpdateState({ state: 'checking' });
    });
    autoUpdater.on('update-available', () => setUpdateState({ state: 'downloading' }));
    autoUpdater.on('update-not-available', () => setUpdateState({ state: 'none', checkedAt: Date.now() }));
    autoUpdater.on('update-downloaded', (_e, _notes, releaseName) => {
      setUpdateState({ state: 'ready', version: String(releaseName || '').replace(/^v/, '') });
    });
    autoUpdater.on('error', (err) => {
      if (updateState.state !== 'ready') setUpdateState({ state: 'error', message: err && err.message });
    });
    checkForUpdates = () => {
      if (updateState.state === 'ready' || updateState.state === 'downloading') {
        setUpdateState(updateState);
        return;
      }
      autoUpdater.checkForUpdates();
    };
    // Squirrel holds a lock on first run after install; give it time.
    const firstRun = process.argv.includes('--squirrel-firstrun');
    setTimeout(checkForUpdates, firstRun ? 60 * 1000 : 10 * 1000);
    setInterval(checkForUpdates, UPDATE_INTERVAL_MS);
    return;
  }

  if (process.platform === 'darwin') {
    const { net } = require('electron');
    checkForUpdates = async () => {
      setUpdateState({ state: 'checking' });
      try {
        const res = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
          headers: { Accept: 'application/vnd.github+json' },
        });
        if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
        const rel = await res.json();
        const latest = String(rel.tag_name || '').replace(/^v/, '');
        if (latest && compareVersions(latest, app.getVersion()) > 0) {
          setUpdateState({ state: 'available', version: latest, url: rel.html_url || RELEASES_PAGE });
        } else {
          setUpdateState({ state: 'none', checkedAt: Date.now() });
        }
      } catch (err) {
        setUpdateState({ state: 'error', message: err.message });
      }
    };
    setTimeout(checkForUpdates, 10 * 1000);
    setInterval(checkForUpdates, MAC_CHECK_INTERVAL_MS);
    return;
  }

  updateState = { state: 'unsupported', reason: 'Not supported on this platform' };
}

function installUpdate() {
  if (updateState.state === 'ready') {
    require('electron').autoUpdater.quitAndInstall();
  } else if (updateState.state === 'available') {
    shell.openExternal(updateState.url || RELEASES_PAGE);
  }
}

function updateStatusText() {
  switch (updateState.state) {
    case 'checking': return 'Checking for updates…';
    case 'downloading': return 'Downloading an update…';
    case 'ready': return `Version ${updateState.version || 'update'} is ready. Restart to install.`;
    case 'available': return `Version ${updateState.version} is available to download.`;
    case 'none': return 'You have the latest version.';
    case 'error': return 'Could not check for updates. Please check your internet connection.';
    case 'unsupported': return `Automatic updates are off (${updateState.reason}).`;
    default: return 'Update check pending.';
  }
}

function showManualCheckResult() {
  if (updateState.state === 'ready' || updateState.state === 'available') {
    const isReady = updateState.state === 'ready';
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Update available',
      message: updateStatusText(),
      buttons: [isReady ? 'Restart now' : 'Download', 'Later'],
      defaultId: 0,
      cancelId: 1,
    }).then(({ response }) => { if (response === 0) installUpdate(); });
  } else {
    dialog.showMessageBox(mainWindow, {
      type: updateState.state === 'error' ? 'warning' : 'info',
      title: 'Check for Updates',
      message: updateStatusText(),
      detail: updateState.state === 'error' && updateState.message ? updateState.message : undefined,
    });
  }
}

function manualCheckForUpdates() {
  if (updateState.state === 'unsupported') {
    showManualCheckResult();
    return;
  }
  manualCheckPending = true;
  checkForUpdates();
}

function showAbout() {
  const { nativeImage } = require('electron');
  dialog.showMessageBox(mainWindow, {
    type: 'none',
    icon: nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png')).resize({ width: 64, height: 64 }),
    title: 'About SCD Moodle',
    message: `SCD Moodle  v${app.getVersion()}`,
    detail:
      `${updateStatusText()}\n\n` +
      `Electron ${process.versions.electron} · Chromium ${process.versions.chrome}\n` +
      `${usingGpuFallback ? 'Graphics: OpenGL compatibility mode\n' : ''}` +
      `github.com/${REPO}`,
    buttons: ['OK', 'Check for Updates'],
    defaultId: 0,
    cancelId: 0,
  }).then(({ response }) => { if (response === 1) manualCheckForUpdates(); });
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
  setupUpdates();
  const incognito = getIncognitoSession();

  Menu.setApplicationMenu(buildMenu());

  // ── Main window ───────────────────────────────────────────────────────────
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 600,
    minHeight: 400,
    title: `SCD Moodle — v${app.getVersion()}`,
    icon: path.join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
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

  ipcMain.handle('app:get-info', () => ({ version: app.getVersion(), update: updateState }));
  ipcMain.on('app:show-about', showAbout);
  ipcMain.on('update:install', installUpdate);

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
    {
      label: 'Help',
      submenu: [
        { label: `SCD Moodle  v${app.getVersion()}`, enabled: false },
        { type: 'separator' },
        { label: 'Check for Updates…', click: manualCheckForUpdates },
        { type: 'separator' },
        { label: 'About SCD Moodle', click: showAbout },
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}
