const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aemeath', {
  onPlay: (cb) => ipcRenderer.on('play', (e, payload) => cb(payload)),
  onWarmup: (cb) => ipcRenderer.on('warmup', () => cb()),
  onClear: (cb) => ipcRenderer.on('clear', () => cb()),
  onSelectClip: (cb) => ipcRenderer.on('select-clip', (e, payload) => cb(payload)),
  done: () => ipcRenderer.send('playback-done'),
  ready: () => ipcRenderer.send('renderer-ready'),
  closeSettings: () => ipcRenderer.send('close-settings'),
  testPlay: () => ipcRenderer.send('test-play'),
  fitScreen: (w, h) => ipcRenderer.send('fit-screen', w, h),

  // 设置窗口用
  listClips: () => ipcRenderer.invoke('list-clips'),
  clipPayload: (id) => ipcRenderer.invoke('clip-payload', id),
  setClipHotkey: (id, accel) => ipcRenderer.invoke('set-clip-hotkey', id, accel),
  setActiveClip: (id) => ipcRenderer.invoke('set-active-clip', id),
  renameClip: (id, name) => ipcRenderer.invoke('rename-clip', id, name),
  deleteClip: (id) => ipcRenderer.invoke('delete-clip', id),
  playClip: (id) => ipcRenderer.invoke('play-clip', id),
  importClip: () => ipcRenderer.invoke('import-clip')
});
