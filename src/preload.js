const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Toolbar → main
  refresh: () => ipcRenderer.send('toolbar:refresh'),
  goBack:  () => ipcRenderer.send('toolbar:go-back'),
  showAbout: () => ipcRenderer.send('app:show-about'),
  installUpdate: () => ipcRenderer.send('update:install'),
  getAppInfo: () => ipcRenderer.invoke('app:get-info'),

  // Main → toolbar
  onLoadingState: (callback) => {
    const handler = (_event, isLoading) => callback(isLoading);
    ipcRenderer.on('loading-state', handler);
    return () => ipcRenderer.removeListener('loading-state', handler);
  },
  onCanGoBack: (callback) => {
    const handler = (_event, canGoBack) => callback(canGoBack);
    ipcRenderer.on('can-go-back', handler);
    return () => ipcRenderer.removeListener('can-go-back', handler);
  },
  onUpdateState: (callback) => {
    const handler = (_event, state) => callback(state);
    ipcRenderer.on('update-state', handler);
    return () => ipcRenderer.removeListener('update-state', handler);
  },
});
