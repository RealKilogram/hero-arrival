const { app, BrowserWindow, globalShortcut, ipcMain, Tray, Menu, screen, nativeImage, clipboard, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { createLiveServer } = require('./livesrc/server');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const LOG_PATH = path.join(__dirname, 'app.log');
const CLIPS_DIR = path.join(__dirname, 'assets', 'clips');

// 单次素材的硬性上限：5 秒（分段预解码，内存恒定，但别让用户无限长）
const MAX_SECONDS = 5;

const DEFAULT_CONFIG = {
  display: 'primary',
  topmost: true,
  passthrough: true,
  localOverlay: true,
  volume: 0.9,
  clips: []
};

function log(...args) {
  const line = new Date().toISOString() + ' ' + args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  try { fs.appendFileSync(LOG_PATH, line + '\n'); } catch (e) { /* ignore */ }
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}

function loadConfig() {
  const cfg = Object.assign({}, DEFAULT_CONFIG, readJson(CONFIG_PATH, {}));
  if (!Array.isArray(cfg.clips)) cfg.clips = [];
  return cfg;
}

function saveConfig(cfg) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
  } catch (e) {
    log('save config failed', String(e));
  }
}

// ---- 素材（clip）管理 ----
function clipDir(id) {
  return path.join(CLIPS_DIR, id);
}

function readClipMeta(id) {
  const meta = readJson(path.join(clipDir(id), 'clip.json'), null);
  if (!meta) return null;
  return {
    id,
    name: meta.name || id,
    count: Number(meta.count) || 0,
    fps: Number(meta.fps) || 60,
    width: Number(meta.width) || 0,
    height: Number(meta.height) || 0
  };
}

// 扫描 assets/clips 下所有带 clip.json 的目录，合并进配置
function syncClips() {
  let changed = false;
  if (!fs.existsSync(CLIPS_DIR)) fs.mkdirSync(CLIPS_DIR, { recursive: true });
  const found = new Set();
  for (const name of fs.readdirSync(CLIPS_DIR)) {
    const dir = path.join(CLIPS_DIR, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    const meta = readClipMeta(name);
    if (!meta || !meta.count) continue;
    found.add(name);
    let entry = config.clips.find((c) => c.id === name);
    if (!entry) {
      entry = { id: name, hotkey: '' };
      config.clips.push(entry);
      changed = true;
    }
    if (entry.name !== meta.name) { entry.name = meta.name; changed = true; }
    if (entry.count !== meta.count) { entry.count = meta.count; changed = true; }
    if (entry.fps !== meta.fps) { entry.fps = meta.fps; changed = true; }
  }
  // 目录被删掉的，配置里也移除
  const before = config.clips.length;
  config.clips = config.clips.filter((c) => found.has(c.id));
  if (config.clips.length !== before) changed = true;
  if (changed) saveConfig(config);
  return config.clips;
}

function clipById(id) {
  return config.clips.find((c) => c.id === id) || null;
}

function activeClip() {
  return clipById(config.active) || config.clips[0] || null;
}

let config = loadConfig();
let overlayWins = [];
let settingsWin = null;
let tray = null;
let currentlyPlaying = false;
let rendererReady = false;
let warnedWarming = false;
let lastClipId = '';

function targetDisplays() {
  if (config.display === 'all') return screen.getAllDisplays();
  return [screen.getPrimaryDisplay()];
}

function createOverlay(display) {
  const b = display.bounds;
  const win = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    title: '英雄登场',
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: false,
    hasShadow: false,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.setIgnoreMouseEvents(config.passthrough !== false, { forward: true });
  applyTopmost(win);
  win.webContents.on('console-message', (e, level, message) => log('[renderer]', message));
  win.webContents.on('did-finish-load', () => log('[overlay] loaded', JSON.stringify(win.getBounds())));
  win.webContents.on('did-fail-load', (e, code, desc) => log('[overlay] load failed', code, desc));
  const freezeArg = process.argv.find((a) => a.startsWith('--freeze='));
  const q = {};
  if (freezeArg) q.freeze = freezeArg.split('=')[1];
  win.loadFile('index.html', { query: q });
  return win;
}

function ensureOverlays() {
  const displays = targetDisplays();
  if (overlayWins.length === displays.length) return;
  overlayWins.forEach((w) => { if (!w.isDestroyed()) w.destroy(); });
  overlayWins = displays.map(createOverlay);
  overlayWins.forEach((w) => {
    if (w.isDestroyed()) return;
    w.once('ready-to-show', () => {
      w.showInactive();
      applyTopmost(w);
    });
  });
  log('[main] overlays created', overlayWins.length);
}

function listSounds(id) {
  const d = path.join(clipDir(id), 'sounds');
  if (!fs.existsSync(d)) return [];
  try {
    return fs.readdirSync(d).filter((f) => /\.(mp3|wav|ogg|m4a|aac)$/i.test(f)).sort();
  } catch (e) {
    return [];
  }
}

function playPayload(clip) {
  return {
    id: clip.id,
    name: clip.name,
    dir: 'assets/clips/' + clip.id,
    count: clip.count,
    fps: clip.fps,
    sounds: listSounds(clip.id),
    volume: config.volume == null ? 0.9 : config.volume
  };
}

function playOnce(clipId) {
  if (currentlyPlaying) return;
  const clip = clipById(clipId) || activeClip();
  if (!clip) { notify('没有素材', '先在设置里导入一个素材。'); return; }
  const local = config.localOverlay !== false;
  if (local) ensureOverlays();
  currentlyPlaying = true;
  log('[main] playOnce', clip.id, 'local', local);
  if (local) {
    if (!rendererReady && !warnedWarming) {
      warnedWarming = true;
      notify('素材加载中', '首次启动要预解码素材（一两秒），加载完会自动播放这一次。');
    }
    for (const win of overlayWins) {
      if (win.isDestroyed()) continue;
      win.showInactive();
      applyTopmost(win);
      win.webContents.send('play', playPayload(clip));
    }
    lastClipId = clip.id;
    log('[main] visible', overlayWins.map((w) => w.isVisible()).join(','));
  }
  if (liveServer) liveServer.trigger(clip.id);
}

function hideOverlays() {
  currentlyPlaying = false;
  log('[main] hide');
  for (const win of overlayWins) {
    if (!win.isDestroyed()) win.webContents.send('clear');
  }
}

// ---- 热键：每个素材一个 ----
function registerAllHotkeys() {
  globalShortcut.unregisterAll();
  const results = [];
  for (const clip of config.clips) {
    if (!clip.hotkey) continue;
    try {
      const ok = globalShortcut.register(clip.hotkey, () => {
        if (currentlyPlaying) return;
        playOnce(clip.id);
      });
      results.push({ id: clip.id, hotkey: clip.hotkey, ok });
      if (!ok) log('[main] hotkey failed', clip.id, clip.hotkey);
    } catch (e) {
      results.push({ id: clip.id, hotkey: clip.hotkey, ok: false, error: String(e.message || e) });
    }
  }
  log('[main] hotkeys', JSON.stringify(results));
  return results;
}

function setClipHotkey(id, accelerator) {
  const clip = clipById(id);
  if (!clip) return { ok: false, error: '素材不存在' };
  const prev = clip.hotkey;
  clip.hotkey = accelerator;
  const results = registerAllHotkeys();
  const mine = results.find((r) => r.id === id);
  if (!mine || !mine.ok) {
    clip.hotkey = prev;
    registerAllHotkeys();
    return { ok: false, error: mine && mine.hotkey ? ('该热键已被占用：' + mine.hotkey) : '注册失败' };
  }
  saveConfig(config);
  refreshTray();
  return { ok: true };
}

function selectClip(id) {
  const c = clipById(id);
  if (!c) return;
  config.active = id;
  saveConfig(config);
  refreshTray();
  // 先在后台解好，按热键时才不用等
  const payload = playPayload(c);
  overlayWins.forEach((w) => {
    if (!w.isDestroyed()) w.webContents.send('select-clip', payload);
  });
}

function trayMenu() {
  const clipItems = config.clips.map((c) => ({
    label: (c.name || c.id) + (c.hotkey ? '   ' + c.hotkey : '   未设热键'),
    type: 'radio',
    checked: config.active === c.id,
    click: () => selectClip(c.id)
  }));
  const tmpl = [
    { label: '触发一次', click: () => playOnce() },
    { label: '设置热键…', click: () => openSettings() },
    { type: 'separator' }
  ];
  if (clipItems.length) {
    tmpl.push({ label: '当前素材', submenu: clipItems });
    tmpl.push({ type: 'separator' });
  }
  tmpl.push(
    {
      label: '显示范围',
      submenu: [
        { label: '主显示器', type: 'radio', checked: config.display !== 'all', click: () => setDisplay('primary') },
        { label: '所有显示器', type: 'radio', checked: config.display === 'all', click: () => setDisplay('all') }
      ]
    },
    { type: 'separator' },
    { label: '窗口置顶', type: 'checkbox', checked: config.topmost !== false, click: (item) => setTopmost(item.checked) },
    { label: '鼠标穿透', type: 'checkbox', checked: config.passthrough !== false, click: (item) => setPassthrough(item.checked) },
    {
      label: '本机同时播放',
      type: 'checkbox',
      checked: config.localOverlay !== false,
      click: (item) => {
        config.localOverlay = item.checked;
        saveConfig(config);
        notify(item.checked ? '本机也会播放' : '只播到直播里',
          item.checked ? '按热键时，你自己屏幕上也会出现。' : '按热键时只有直播画面里出现，自己屏幕不受影响。');
      }
    },
    { type: 'separator' },
    {
      label: '浏览器源（直播姬 / OBS）',
      submenu: [
        {
          label: '复制地址  ' + liveUrl(),
          click: () => {
            clipboard.writeText(liveUrl());
            notify('地址已复制', liveUrl() + '  粘到直播姬的「浏览器源」里即可。');
          }
        },
        { label: '在浏览器中预览', click: () => shell.openExternal(liveUrl()) },
        { label: '复制带音效的地址', click: () => { clipboard.writeText(liveUrl() + '?sound=1'); notify('已复制', '带 ?sound=1 的地址，音频由浏览器源输出。'); } },
        { type: 'separator' },
        { label: liveServer && liveServer.running ? ('服务运行中，端口 ' + liveServer.port + '，已连接 ' + liveServer.clients) : '服务未启动', enabled: false }
      ]
    },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() }
  );
  return Menu.buildFromTemplate(tmpl);
}

function refreshTray() {
  if (!tray) return;
  const clip = activeClip();
  tray.setToolTip('英雄登场' + (clip ? '（' + clip.name + ' ' + (clip.hotkey || '未设热键') + '）' : ''));
  tray.setContextMenu(trayMenu());
}

// ---- 设置窗口 ----
function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 520,
    height: 560,
    resizable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    title: '英雄登场 · 设置',
    icon: ICON_PATH,
    backgroundColor: '#141018',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  settingsWin.loadFile('settings.html');
  log('[settings] opened');
  settingsWin.on('closed', () => { settingsWin = null; log('[settings] closed'); });
}

function setDisplay(mode) {
  config.display = mode;
  saveConfig(config);
  rebuildOverlays();
}

function notify(title, content) {
  try {
    if (tray) tray.displayBalloon({ title, content, iconType: 'info' });
  } catch (e) {
    log('[main] notify failed', e.message);
  }
}

function applyTopmost(win) {
  if (win.isDestroyed()) return;
  if (config.topmost !== false) win.setAlwaysOnTop(true, 'screen-saver');
  else win.setAlwaysOnTop(false);
}

function setPassthrough(on) {
  config.passthrough = !!on;
  saveConfig(config);
  overlayWins.forEach((w) => {
    if (w.isDestroyed()) return;
    w.setIgnoreMouseEvents(!!config.passthrough, { forward: true });
  });
  log('[main] passthrough', config.passthrough);
  refreshTray();
}

function setTopmost(on) {
  config.topmost = !!on;
  saveConfig(config);
  overlayWins.forEach(applyTopmost);
  if (config.topmost) overlayWins.forEach((w) => { if (!w.isDestroyed()) w.showInactive(); });
  log('[main] topmost', config.topmost);
  refreshTray();
}

function rebuildOverlays() {
  overlayWins.forEach((w) => { if (!w.isDestroyed()) w.destroy(); });
  overlayWins = [];
  ensureOverlays();
  overlayWins.forEach((w) => w.webContents.once('did-finish-load', () => w.webContents.send('warmup')));
  refreshTray();
}

const ICON_PATH = path.join(__dirname, 'assets', 'icon.png');

function appIcon(size) {
  if (!fs.existsSync(ICON_PATH)) return nativeImage.createEmpty();
  const img = nativeImage.createFromPath(ICON_PATH);
  return img.isEmpty() ? nativeImage.createEmpty() : img.resize({ width: size, height: size, quality: 'best' });
}

function buildTray() {
  const sf = screen.getPrimaryDisplay().scaleFactor || 1;
  const px = Math.max(16, Math.round(16 * sf));
  let icon = appIcon(px);
  if (icon.isEmpty()) {
    const legacy = path.join(__dirname, 'assets', 'tray.png');
    if (fs.existsSync(legacy)) icon = nativeImage.createFromPath(legacy);
  }
  tray = new Tray(icon);
  log('[main] tray icon', JSON.stringify(icon.getSize()), 'empty', icon.isEmpty());
  refreshTray();
  tray.on('double-click', () => playOnce());
}

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let liveServer = null;

function liveUrl() {
  return 'http://127.0.0.1:' + (liveServer ? liveServer.port : 17321) + '/';
}

// ---- 素材导入 / 删除 / 重命名 ----
function safeId(name) {
  const base = String(name || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  let id = base || 'clip';
  let n = 2;
  while (fs.existsSync(clipDir(id))) { id = base + '-' + n; n += 1; }
  return id;
}

function importClipFromDir(srcDir) {
  const metaPath = path.join(srcDir, 'clip.json');
  if (!fs.existsSync(metaPath)) {
    return { ok: false, error: '这个文件夹里没有 clip.json，不是素材包' };
  }
  const meta = readJson(metaPath, null);
  if (!meta || !meta.count) return { ok: false, error: 'clip.json 内容不完整' };
  const framesSrc = path.join(srcDir, 'frames');
  if (!fs.existsSync(framesSrc)) return { ok: false, error: '缺少 frames 文件夹' };
  const count = fs.readdirSync(framesSrc).filter((f) => /\.webp$/i.test(f)).length;
  if (count !== Number(meta.count)) {
    return { ok: false, error: '帧数不一致：clip.json 写 ' + meta.count + '，实际有 ' + count + ' 张' };
  }
  const fps0 = Number(meta.fps) || 60;
  const seconds = count / fps0;
  // 时长不阻止导入，但超长会提醒
  const longWarn = seconds > MAX_SECONDS
    ? '已导入，但这段素材有 ' + seconds.toFixed(1) + ' 秒（超过 ' + MAX_SECONDS + ' 秒）：播放期间热键会被这条占住，播完才能再触发。'
    : '';
  const id = safeId(meta.name || path.basename(srcDir));
  const dst = clipDir(id);
  fs.mkdirSync(path.join(dst, 'frames'), { recursive: true });
  for (const f of fs.readdirSync(framesSrc)) {
    fs.copyFileSync(path.join(framesSrc, f), path.join(dst, 'frames', f));
  }
  const soundsSrc = path.join(srcDir, 'sounds');
  fs.mkdirSync(path.join(dst, 'sounds'), { recursive: true });
  const soundNames = [];
  if (fs.existsSync(soundsSrc)) {
    for (const f of fs.readdirSync(soundsSrc)) {
      if (!/\.(mp3|wav|ogg|m4a|aac)$/i.test(f)) continue;
      fs.copyFileSync(path.join(soundsSrc, f), path.join(dst, 'sounds', f));
      soundNames.push(f);
    }
  }
  fs.writeFileSync(path.join(dst, 'clip.json'), JSON.stringify({
    name: meta.name || id,
    count,
    fps: Number(meta.fps) || 60,
    width: Number(meta.width) || 0,
    height: Number(meta.height) || 0,
    sounds: soundNames
  }, null, 2), 'utf8');
  syncClips();
  const entry = clipById(id);
  if (entry && !config.active) { config.active = id; saveConfig(config); }
  refreshTray();
  return { ok: true, id, name: meta.name || id, count, seconds, warn: longWarn };
}

function deleteClip(id) {
  const idx = config.clips.findIndex((c) => c.id === id);
  if (idx < 0) return { ok: false, error: '素材不存在' };
  const dir = clipDir(id);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    return { ok: false, error: '删除失败：' + String(e.message || e) };
  }
  config.clips.splice(idx, 1);
  if (config.active === id) config.active = config.clips[0] ? config.clips[0].id : '';
  saveConfig(config);
  registerAllHotkeys();
  refreshTray();
  return { ok: true };
}

function renameClip(id, name) {
  const clean = String(name || '').trim().slice(0, 24);
  if (!clean) return { ok: false, error: '名字不能为空' };
  const metaFile = path.join(clipDir(id), 'clip.json');
  const meta = readJson(metaFile, null);
  if (!meta) return { ok: false, error: '素材不存在' };
  meta.name = clean;
  fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2), 'utf8');
  const entry = clipById(id);
  if (entry) entry.name = clean;
  saveConfig(config);
  refreshTray();
  return { ok: true, name: clean };
}

// 单实例
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  log('[main] another instance is running, exiting');
  app.quit();
} else {
app.on('second-instance', () => {
  log('[main] second instance blocked');
  if (tray && !tray.isDestroyed()) {
    try {
      tray.displayBalloon({
        title: '英雄登场',
        content: '程序已经在运行了（右下角托盘图标）。右键它可触发或改热键。',
        iconType: 'info'
      });
    } catch (e) { /* 旧系统不支持气球提示 */ }
  }
});

app.whenReady().then(() => {
  syncClips();
  if (!config.active && config.clips.length) {
    config.active = config.clips[0].id;
    saveConfig(config);
  }
  log('[main] ready', JSON.stringify(config));
  registerAllHotkeys();
  buildTray();
  ensureOverlays();
  overlayWins.forEach((w) => w.webContents.once('did-finish-load', () => w.webContents.send('warmup')));

  liveServer = createLiveServer({ root: __dirname, index: 'livesrc/index.html', port: 17321, log });
  liveServer.start().then(() => refreshTray());

  ipcMain.on('playback-done', () => hideOverlays());
  ipcMain.on('renderer-ready', () => {
    rendererReady = true;
    log('[main] renderer ready');
  });
  ipcMain.handle('get-config', () => ({ volume: config.volume, clips: config.clips }));
  ipcMain.handle('list-clips', () => ({ clips: syncClips(), active: config.active, maxSeconds: MAX_SECONDS, volume: config.volume }));
  ipcMain.handle('clip-payload', (e, id) => {
    const c = clipById(id);
    return c ? playPayload(c) : null;
  });
  ipcMain.handle('set-clip-hotkey', (e, id, accel) => setClipHotkey(id, accel));
  ipcMain.handle('set-active-clip', async (e, id) => {
    if (!clipById(id)) return { ok: false };
    selectClip(id);
    return { ok: true };
  });
  ipcMain.handle('rename-clip', (e, id, name) => renameClip(id, name));
  ipcMain.handle('delete-clip', (e, id) => deleteClip(id));
  ipcMain.handle('play-clip', (e, id) => { playOnce(id); return { ok: true }; });
  ipcMain.handle('import-clip', async (e) => {
    const r = await dialog.showOpenDialog(settingsWin || undefined, {
      title: '选择素材包文件夹（含 clip.json 和 frames）',
      properties: ['openDirectory']
    });
    if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
    try {
      return importClipFromDir(r.filePaths[0]);
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });
  ipcMain.on('close-settings', () => {
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close();
  });
  ipcMain.on('test-play', () => playOnce());
  log('[main] argv', JSON.stringify(process.argv.slice(1)));
  if (process.env.AEMEATH_SETTINGS === '1' || process.argv.includes('--settings')) setTimeout(() => openSettings(), 600);
  ipcMain.on('fit-screen', (e, w, h) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win || !w || !h) return;
    const b = win.getBounds();
    win.setBounds({ x: b.x, y: b.y, width: Math.round(w), height: Math.round(h) });
    log('[main] fit', Math.round(w), Math.round(h), JSON.stringify(win.getBounds()));
  });

  if (process.argv.includes('--demo')) {
    setTimeout(() => playOnce(), 2000);
    setInterval(() => playOnce(), 2600);
  }
});
}

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => { /* keep running in tray */ });
