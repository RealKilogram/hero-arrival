const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d', { alpha: true });
const params = new URLSearchParams(location.search);
const FREEZE = params.get('freeze');

// ---- 素材与分段缓存 ----
// 内存里只保留「当前播放位置附近」的帧，素材多长都只占固定内存。
const AHEAD = 90;      // 往后预解码 1.5 秒
const BEHIND = 40;     // 已播过的保留一小段（拖动/重播时不用重解）
const CONCURRENCY = 8;

let clip = null;                 // { dir, count, fps, name }
let cache = new Map();           // index -> ImageBitmap
let loading = new Map();         // index -> Promise
let token = 0;                   // 切换素材时作废旧的解码任务

let playing = false;
let timer = 0;
let playT0 = 0;
let draws = 0;
let lastIdx = -1;
let ready = false;
let pendingPlay = false;
let refilling = false;
let pendingTimer = 0;

function frameUrl(i) {
  return clip.dir + '/frames/' + String(i).padStart(3, '0') + '.webp';
}

function decodeTarget() {
  const dpr = window.devicePixelRatio || 1;
  const screenW = Math.round(innerWidth * dpr);
  const ar = clip && clip.width && clip.height ? clip.height / clip.width : 1400 / 2560;
  // 不放大超过素材原始尺寸：源 1920 就解到 1920，再往上是白白多占内存
  const cap = clip && clip.width ? clip.width : screenW;
  let tw = Math.min(screenW, cap);
  // 帧数特别多的时候才降分辨率，保证总占用可控
  const budget = 1200; // 目标内存上限（MB）
  const perFrame = (tw * tw * ar * 4) / (1024 * 1024);
  const maxFrames = Math.max(60, Math.floor(budget / Math.max(perFrame, 0.1)));
  const shrink = clip && clip.count > maxFrames ? Math.sqrt(maxFrames / clip.count) : 1;
  const w = Math.max(320, Math.round(tw * shrink));
  return [w, Math.max(2, Math.round(w * ar))];
}

async function decodeOne(i, myToken) {
  if (cache.has(i)) return cache.get(i);
  if (loading.has(i)) return loading.get(i);
  const p = (async () => {
    try {
      const [tw, th] = decodeTarget();
      const r = await fetch(frameUrl(i));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const blob = await r.blob();
      if (myToken !== token) return null;
      const bmp = await createImageBitmap(blob, {
        resizeWidth: tw,
        resizeHeight: th,
        resizeQuality: 'medium'
      });
      if (myToken !== token) { bmp.close && bmp.close(); return null; }
      cache.set(i, bmp);
      return bmp;
    } catch (e) {
      return null;
    } finally {
      loading.delete(i);
    }
  })();
  loading.set(i, p);
  return p;
}

// 能全量常驻的帧数：按当前解码尺寸和 1200MB 预算算
function keepAllLimit() {
  const [w, h] = decodeTarget();
  const mb = (w * h * 4) / (1024 * 1024);
  return Math.max(60, Math.floor(1200 / Math.max(mb, 0.1)));
}

function evict(center) {
  if (clip && clip.count <= keepAllLimit()) return; // 装得下就全留着，重复触发才不会缺帧
  const lo = center - BEHIND;
  for (const [i, bmp] of cache) {
    if (i < lo) {
      bmp.close && bmp.close();
      cache.delete(i);
    }
  }
}

// 后台把 [from, to) 补齐；不阻塞播放
async function ensureRange(from, to, myToken) {
  const queue = [];
  for (let i = from; i < to; i++) if (!cache.has(i)) queue.push(i);
  let ptr = 0;
  const lane = async () => {
    while (ptr < queue.length) {
      if (myToken !== token) return;
      const i = queue[ptr++];
      await decodeOne(i, myToken);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, lane));
}

let aheadTimer = 0;
function startAheadLoop() {
  clearInterval(aheadTimer);
  aheadTimer = setInterval(() => {
    if (!clip || !playing) return;
    const myToken = token;
    const from = Math.max(0, lastIdx);
    const to = Math.min(clip.count, lastIdx + AHEAD);
    if (cache.size < AHEAD + BEHIND) ensureRange(from, to, myToken);
    evict(lastIdx);
  }, 250);
}

function fit() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(innerWidth * dpr);
  canvas.height = Math.round(innerHeight * dpr);
  canvas.style.width = innerWidth + 'px';
  canvas.style.height = innerHeight + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function drawBitmap(bmp) {
  // 直接用画布物理像素绘制，避免「CSS 尺寸 + transform」造成的二次重采样
  const cw = canvas.width;
  const ch = canvas.height;
  const scale = Math.max(cw / bmp.width, ch / bmp.height);
  const dw = bmp.width * scale;
  const dh = bmp.height * scale;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cw, ch);
  ctx.drawImage(bmp, Math.round((cw - dw) / 2), Math.round((ch - dh) / 2), Math.round(dw), Math.round(dh));
}

function clearStage() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

// ---- 音效 ----
let audioCtx = null;
let soundBufs = [];
let currentSound = null;
let volume = 0.9;
let soundDir = '';

async function loadSounds(dir, names) {
  soundBufs = [];
  soundDir = dir;
  if (!dir || !Array.isArray(names) || !names.length) return;
  try {
    if (!audioCtx) audioCtx = new AudioContext();
    const bufs = await Promise.all(names.map(async (n) => {
      try {
        const r = await fetch(dir + '/sounds/' + encodeURIComponent(n));
        if (!r.ok) return null;
        return await audioCtx.decodeAudioData(await r.arrayBuffer());
      } catch (e) { return null; }
    }));
    soundBufs = bufs.filter(Boolean);
    console.log('[sound] ready', soundBufs.length);
  } catch (e) {
    console.log('[sound] init fail', e.message);
  }
}

function playSound() {
  if (!audioCtx || !soundBufs.length) return;
  try {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    if (currentSound) { try { currentSound.stop(); } catch (e) { /* ended */ } }
    const buf = soundBufs[Math.floor(Math.random() * soundBufs.length)];
    const src = audioCtx.createBufferSource();
    const gain = audioCtx.createGain();
    gain.gain.value = volume;
    src.buffer = buf;
    src.connect(gain).connect(audioCtx.destination);
    src.start();
    currentSound = src;
    console.log('[sound] play', soundBufs.indexOf(buf));
  } catch (e) {
    console.log('[sound] play fail', e.message);
  }
}

// ---- 播放 ----
async function setClip(payload) {
  token += 1;
  const myToken = token;
  for (const [, bmp] of cache) bmp.close && bmp.close();
  cache.clear();
  loading.clear();
  clip = {
    dir: payload.dir,
    count: payload.count,
    fps: payload.fps || 60,
    width: payload.width || 0,
    height: payload.height || 0,
    name: payload.name || ''
  };
  volume = payload.volume == null ? 0.9 : Number(payload.volume);
  ready = false;
  await loadSounds(payload.dir, payload.sounds);
  // 全部解完再就绪：边播边解会占满主线程，长素材必卡
  const head = clip.count;
  await ensureRange(0, head, myToken);
  if (myToken !== token) return false;
  ready = cache.size > 0;
  console.log('[clip] ready', clip.name, clip.count, 'frames, cached', cache.size);
  window.aemeath.ready();
  return true;
}

function flushPending() {
  if (!pendingPlay) return;
  pendingPlay = false;
  clearTimeout(pendingTimer);
  console.log('[play] flushing queued trigger');
  play();
}

function play() {
  if (!clip || playing) return;
  if (!ready) {
    if (!pendingPlay) {
      pendingPlay = true;
      console.log('[play] queued until clip ready');
      pendingTimer = setTimeout(() => {
        if (!ready && pendingPlay) {
          pendingPlay = false;
          const b = cache.values().next().value;
          if (b) drawBitmap(b);
          window.aemeath.done();
        }
      }, 15000);
    }
    return;
  }
  // 播放前确认帧都在；有缺失就先补完再播，避免缺帧闪一下
  let miss = 0;
  for (let i = 0; i < clip.count; i++) if (!cache.has(i)) miss++;
  if (miss > 0) {
    if (!refilling) {
      refilling = true;
      const myToken = token;
      console.log('[play] refilling', miss, 'frames before start');
      ensureRange(0, clip.count, myToken).then(() => {
        refilling = false;
        if (myToken === token) play();
      });
    }
    return;
  }
  playing = true;
  draws = 0;
  lastIdx = -1;
  playSound();
  startAheadLoop();
  const first = cache.get(0);
  if (first) drawBitmap(first);
  const interval = 1000 / clip.fps;
  const total = interval * clip.count;
  const t0 = performance.now();
  playT0 = t0;

  cancelAnimationFrame(timer);
  const loop = () => {
    if (!playing) return;
    const elapsed = performance.now() - t0;
    if (elapsed >= total) { finish(); return; }
    const idx = Math.min(clip.count - 1, Math.floor(elapsed / interval));
    if (idx !== lastIdx) {
      const bmp = cache.get(idx);
      if (bmp) {
        drawBitmap(bmp);
        lastIdx = idx;
        draws += 1;
      }
      // 还没解到就等下一帧（保持上一帧，不闪黑）
    }
    timer = requestAnimationFrame(loop);
  };
  timer = requestAnimationFrame(loop);
}

function finish() {
  playing = false;
  cancelAnimationFrame(timer);
  timer = 0;
  clearInterval(aheadTimer);
  console.log('[finish] drawn', draws, 'of', clip ? clip.count : 0,
    'in', Math.round(performance.now() - playT0), 'ms');
  clearStage();
  window.aemeath.done();
}

window.addEventListener('resize', () => { fit(); });
window.addEventListener('error', (e) => console.log('[err]', e.message, e.lineno));

window.aemeath.onPlay(async (payload) => {
  if (!payload) return;
  const switched = !clip || clip.dir !== payload.dir;
  if (switched) await setClip(payload);
  else volume = payload.volume == null ? volume : Number(payload.volume);
  if (!playing) play();
});

window.aemeath.onClear(() => { if (!playing) clearStage(); });

// 在设置里切到另一个素材时，先在后台解好，别等按热键才现解
window.aemeath.onSelectClip(async (payload) => {
  if (!payload || playing) return;
  if (clip && clip.dir === payload.dir) return;
  console.log('[select] preloading', payload.name);
  await setClip(payload);
});

window.aemeath.onWarmup(async () => {
  if (screen.width !== innerWidth || screen.height !== innerHeight) {
    window.aemeath.fitScreen(screen.width, screen.height);
    await new Promise((r) => setTimeout(r, 250));
  }
  fit();
  const list = await window.aemeath.listClips();
  const first = list && list.clips && list.clips.length
    ? (list.clips.find((c) => c.id === list.active) || list.clips[0])
    : null;
  if (first) {
    const payload = await window.aemeath.clipPayload(first.id);
    if (payload) await setClip(payload);
  }
  clearStage();
  if (FREEZE !== null && FREEZE !== undefined && FREEZE !== '') {
    const i = Number(FREEZE) || 0;
    const b = cache.get(i);
    if (b) { drawBitmap(b); console.log('[freeze] frame', i); }
  } else {
    setInterval(() => { if (!playing) clearStage(); }, 250);
  }
  flushPending();
});
