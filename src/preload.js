const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Toolbar → main
  refresh: () => ipcRenderer.send('toolbar:refresh'),
  goBack:  () => ipcRenderer.send('toolbar:go-back'),

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
});
