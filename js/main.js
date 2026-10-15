// DisplayXR Music Visualizer: app shell.
//
// One three.js renderer on one persistent <canvas> for the life of the page (woven-canvas rules
// 1-3). In the DisplayXR Browser on a 3D display the canvas is an inline-3D window: each frame
// we render the current style twice, once per eye, from the views the session hands us. In any
// other browser the same scene renders once, flat.
//
// Each eye goes through a post-processing chain (multisampled HDR render, bloom, output) sized
// to that eye's viewport, and the result lands in the eye's half of the canvas. Styles are
// swapped INSIDE the canvas (a quick fade through black), never by replacing it.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { createInline3D } from '@displayxr/inline3d';
import { EyeCamera, EdgeFeather } from '@displayxr/inline3d/three';
import { AudioEngine } from './audio.js';
import { paletteFromImage } from './palette.js';
import { SPOTIFY_CLIENT_ID } from './config.js';
import { SpotifyService } from './services/spotify.js';
import { YouTubeService } from './services/youtube.js';
import LofiStyle from './styles/lofi.js';
import ImpressionistStyle from './styles/impressionist.js';
import SynthwaveStyle from './styles/synthwave.js';
import NebulaStyle from './styles/nebula.js';
import OrbStyle from './styles/orb.js';

const STYLES = [LofiStyle, ImpressionistStyle, SynthwaveStyle, NebulaStyle, OrbStyle];
const VIRTUAL_DISPLAY_HEIGHT = 0.12;   // the scenes are authored in metres for a 12 cm-tall window
const AUTO_SECONDS = 40;
// Pure black: it survives any colour-space conversion (the composer clears with the value the
// last on-screen draw left behind, which is already sRGB) and it is what a 3D panel shows best.
const BG = 0x000000;

const $ = (id) => document.getElementById(id);
const canvas = $('stage');
const cover = $('cover');
const statusEl = $('status');
const params = new URLSearchParams(location.search);
const store = {
  get(k) { try { return localStorage.getItem('dxr-viz.' + k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem('dxr-viz.' + k) : localStorage.setItem('dxr-viz.' + k, v); } catch {} },
};

// ---- renderer --------------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({
  canvas, antialias: true, alpha: true, preserveDrawingBuffer: true, powerPreference: 'high-performance',
});
// Opaque clear in the page colour: additive styles then glow against a solid backdrop rather
// than punching alpha holes in a transparent canvas. EdgeFeather still fades the edges out.
renderer.setClearColor(BG, 1);
renderer.setPixelRatio(1);              // getViewport() is in buffer pixels; see hello-cube
renderer.autoClear = false;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;

const scene = new THREE.Scene();
const root = new THREE.Group();          // depth slider scales this along z
scene.add(root);
// Slow sway of the whole scene, so the depth keeps changing even when the music is quiet. It
// moves the content, never the eyes: on a display rig the runtime owns the viewpoint.
const drift = new THREE.Group();
root.add(drift);

const eye = new EyeCamera(THREE);
const feather = new EdgeFeather(THREE, { px: 28 });

// Mono camera framed so the z = 0 plane fills the canvas height at 0.12 m, like the 3D window.
const monoCam = new THREE.PerspectiveCamera(40, 16 / 9, 0.005, 10);
const monoDist = VIRTUAL_DISPLAY_HEIGHT / 2 / Math.tan(THREE.MathUtils.degToRad(20));
monoCam.position.set(0, 0, monoDist);

// Fade-through-black between styles, drawn per eye after the scene.
const fadeScene = new THREE.Scene();
const fadeMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0, depthTest: false, depthWrite: false });
const fadeQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), fadeMat);
fadeQuad.frustumCulled = false;
fadeScene.add(fadeQuad);
const fadeCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

// ---- post-processing (per eye) -----------------------------------------------------------------
// One composer, sized to an eye's viewport. Both eyes are the same size, so it is rebuilt only
// when the canvas or the quality changes. Its last pass draws to the screen inside whatever
// viewport and scissor are set, i.e. into the current eye's half.
// maxEyeW caps the post-processing resolution per eye; the output pass scales it up to the eye's
// viewport. On an 8K panel each eye's viewport is ~3700 px wide, more detail than the weave shows,
// and rendering bloom + MSAA at that size held the panel to ~30 fps.
const QUALITY = { ultra: { samples: 4, maxEyeW: 2560 }, high: { samples: 2, maxEyeW: 1920 }, fast: null };
let quality = params.get('quality') in QUALITY ? params.get('quality') : (store.get('quality') in QUALITY ? store.get('quality') : 'ultra');
let glow = params.has('glow') ? Math.max(0, +params.get('glow') || 0) : 1;
let composer = null, renderPass = null, bloomPass = null, composerSize = '';

function buildComposer(w, h) {
  composer?.dispose?.();
  composer = null;
  const q = QUALITY[quality];
  if (!q) return;
  const rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: q.samples });
  composer = new EffectComposer(renderer, rt);
  composer.setPixelRatio(1);
  renderPass = new RenderPass(scene, monoCam);
  bloomPass = new UnrealBloomPass(new THREE.Vector2(w, h), 1, 0.5, 0.6);
  composer.addPass(renderPass);
  composer.addPass(bloomPass);
  composer.addPass(new OutputPass());
  composer.setSize(w, h);
  applyBloom();
}

function applyBloom() {
  if (!bloomPass || !style) return;
  const b = style.constructor.bloom || { strength: 0.6, radius: 0.5, threshold: 0.7 };
  bloomPass.strength = b.strength * glow;
  bloomPass.radius = b.radius;
  bloomPass.threshold = b.threshold;
  bloomPass.enabled = glow > 0.01;
}

function ensureComposer(w, h) {
  const key = `${w}x${h}:${quality}`;
  if (key === composerSize) return;
  composerSize = key;
  buildComposer(w, h);
}

// ---- state -----------------------------------------------------------------------------------
const audio = new AudioEngine();
let style = null;
let styleIndex = Math.max(0, STYLES.findIndex((S) => S.meta.id === params.get('style')));
let pendingIndex = -1;
let fade = 0;                  // 0 = clear, 1 = black
let auto = params.has('auto');
let autoClock = 0;
let sbs = false;               // true once the inline-3D window is live
let wall = null, handle = null;
let last = 0;
let lastGood = null;           // [{ proj, xf, vp }] copies from the last valid stereo frame
let artPalette = null;         // album-art colours, sRGB triples
let matchArt = true;
let variation = Math.max(0, +params.get('var') || 0);
let autoVary = !params.has('novary');
let varClock = 0;
let driftT = 0;
const VARY_SECONDS = 28;

function mountStyle(i) {
  if (style) { drift.remove(style.group); style.dispose(); }
  styleIndex = i;
  style = new STYLES[i](THREE);
  drift.add(style.group);
  if (matchArt && artPalette) style.setPalette?.(artPalette);
  applyBloom();
  autoClock = 0;
  setVariation(variation);
  // A new style starts already in its layout rather than blending in from the default.
  if (style.layout) Object.assign(style.layout.cur, style.layout.target);
  syncStyleButtons();
}

function setVariation(v) {
  const names = style.constructor.variations || [];
  variation = names.length ? ((v % names.length) + names.length) % names.length : 0;
  style.setVariation?.(variation);
  varClock = 0;
  renderVariations();
}

function requestStyle(i) {
  i = (i + STYLES.length) % STYLES.length;
  if (i === styleIndex && pendingIndex < 0) return;
  pendingIndex = i;
}

function tick(dt) {
  audio.update(dt);
  // Style fade: out, swap, back in.
  if (pendingIndex >= 0) {
    fade = Math.min(1, fade + dt / 0.3);
    if (fade >= 1) { mountStyle(pendingIndex); pendingIndex = -1; }
  } else if (fade > 0) {
    fade = Math.max(0, fade - dt / 0.45);
  }
  fadeMat.opacity = fade;
  if (auto && pendingIndex < 0) {
    autoClock += dt;
    if (autoClock > AUTO_SECONDS && audio.beat > 0.9) requestStyle(styleIndex + 1);
  }
  if (autoVary && pendingIndex < 0) {
    varClock += dt;
    if (varClock > VARY_SECONDS && audio.beat > 0.9) setVariation(variation + 1);
  }
  // Two incommensurate sines per axis, so the sway never visibly repeats.
  driftT += dt * (0.6 + audio.level * 0.8);
  const d = style.constructor.drift || { yaw: 0.08, pitch: 0.03 };
  drift.rotation.set(
    d.pitch * (Math.sin(driftT * 0.13) * 0.7 + Math.sin(driftT * 0.071 + 1.3) * 0.3),
    d.yaw * (Math.sin(driftT * 0.09) * 0.7 + Math.sin(driftT * 0.053 + 0.4) * 0.3),
    0,
  );
  style.update(audio, dt);
  meterTick();
}

// ---- drawing ---------------------------------------------------------------------------------
function drawEye(cam, vp) {
  renderer.setViewport(vp.x, vp.y, vp.width, vp.height);
  renderer.setScissor(vp.x, vp.y, vp.width, vp.height);
  const q = QUALITY[quality];
  const s = q ? Math.min(1, q.maxEyeW / vp.width) : 1;
  style.beforeRender?.(vp.height * s);   // point sprites size to the buffer they render into
  if (q) {
    ensureComposer(Math.round(vp.width * s), Math.round(vp.height * s));
    renderPass.camera = cam;
    composer.render();
  } else {
    renderer.render(scene, cam);
  }
  if (fade > 0.001) renderer.render(fadeScene, fadeCam);
  feather.render(renderer, vp);
}

function drawStereo(eyes) {
  renderer.setScissorTest(true);
  renderer.setViewport(0, 0, canvas.width, canvas.height);
  renderer.setScissor(0, 0, canvas.width, canvas.height);
  renderer.clear();
  for (const e of eyes) drawEye(eye.setFromMatrices(e.proj, e.xf), e.vp);
  renderer.setScissorTest(false);
}

function drawMono() {
  const w = canvas.width, h = canvas.height;
  renderer.setScissorTest(true);
  renderer.setViewport(0, 0, w, h);
  renderer.setScissor(0, 0, w, h);
  renderer.clear();
  if (sbs) {
    // Stereo canvas but no usable views yet: the mono picture in both halves.
    monoCam.aspect = (w / 2) / h; monoCam.updateProjectionMatrix();
    drawEye(monoCam, { x: 0, y: 0, width: w / 2, height: h });
    drawEye(monoCam, { x: w / 2, y: 0, width: w / 2, height: h });
  } else {
    monoCam.aspect = w / h; monoCam.updateProjectionMatrix();
    drawEye(monoCam, { x: 0, y: 0, width: w, height: h });
  }
  renderer.setScissorTest(false);
}

function onXRFrame(views, layer) {
  const now = performance.now();
  const dt = last ? (now - last) / 1000 : 1 / 60; last = now;
  tick(dt);
  // Validate BEFORE clearing: a short view list or a missing viewport replays the last good
  // frame instead of committing a black one.
  let ok = views && views.length >= 2;
  const eyes = [];
  if (ok) {
    for (const v of views) {
      const vp = layer.getViewport(v);
      if (!vp) { ok = false; break; }
      eyes.push({ proj: Float32Array.from(v.projectionMatrix), xf: Float32Array.from(v.transform.matrix), vp: { x: vp.x, y: vp.y, width: vp.width, height: vp.height } });
    }
  }
  if (ok) { lastGood = eyes; drawStereo(eyes); }
  else if (lastGood) drawStereo(lastGood);
  else drawMono();
}

// Gentle mouse parallax in 2D, so the depth still reads a little on a flat screen.
const parallax = { x: 0, y: 0, tx: 0, ty: 0 };
addEventListener('pointermove', (e) => {
  parallax.tx = (e.clientX / innerWidth - 0.5) * 0.06;
  parallax.ty = (e.clientY / innerHeight - 0.5) * -0.035;
});

function onMonoFrame(now) {
  if (sbs) return;
  requestAnimationFrame(onMonoFrame);
  const dt = last ? (now - last) / 1000 : 1 / 60; last = now;
  tick(dt);
  parallax.x += (parallax.tx - parallax.x) * 0.05;
  parallax.y += (parallax.ty - parallax.y) * 0.05;
  monoCam.position.set(parallax.x, parallax.y, monoDist);
  monoCam.lookAt(0, 0, 0);
  drawMono();
}

// ---- sizing ----------------------------------------------------------------------------------
// Inline-3D buffers are double width (left eye | right eye). Clamp to the GPU's limits and to
// the panel width, both axes by one factor, so the eye split stays at 50% of the real buffer.
const gl = renderer.getContext();
const glMax = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), gl.getParameter(gl.MAX_VIEWPORT_DIMS)[0]);

function sizeCanvas() {
  const dpr = devicePixelRatio || 1;
  let w = Math.round((canvas.clientWidth || 640) * dpr);
  let h = Math.round((canvas.clientHeight || 360) * dpr);
  const totalW = sbs ? w * 2 : w;
  const maxW = sbs ? Math.min(glMax, Math.round(screen.width * dpr)) : glMax;
  const s = Math.min(1, maxW / totalW, glMax / h);
  w = Math.floor(w * s); h = Math.floor(h * s);
  const bw = sbs ? w * 2 : w;
  // Writing the size reallocates (and clears) the buffer even for the same value, so only
  // write on a real change, then redraw at once.
  if (canvas.width === bw && canvas.height === h) return;
  renderer.setSize(bw, h, false);
  if (!style) return;
  if (sbs && lastGood) drawStereo(lastGood); else drawMono();
}
new ResizeObserver(sizeCanvas).observe(canvas);

// ---- boot ------------------------------------------------------------------------------------
async function boot() {
  mountStyle(styleIndex);
  sizeCanvas();

  try { wall = await createInline3D({ lazy: false }); } catch (e) { console.warn('[visualizer] inline-3D unavailable', e); }
  if (wall?.supported) {
    sbs = true;
    sizeCanvas();
    handle = wall.addScene(canvas, onXRFrame, {
      virtualDisplayHeight: VIRTUAL_DISPLAY_HEIGHT,
      rectCover: 'auto',          // covers the canvas while full view resizes it
      onLayerLost: () => {        // fall back to flat rendering
        sbs = false; lastGood = null; sizeCanvas(); requestAnimationFrame(onMonoFrame);
        setStatus('3D layer lost: showing 2D', 'warn');
      },
    });
    console.info('[visualizer] inline-3D session live: addScene registered, waiting for the first woven frame');
    const r = await handle.firstWoven;
    cover.remove();               // hard cut, never a fade
    console.info(`[visualizer] firstWoven woven=${r.woven} confirmed=${r.confirmed} reason=${r.reason} ms=${Math.round(r.ms)}`);
    setStatus(r.woven ? 'Glasses-free 3D on (DisplayXR). Move your head to look around.' : '3D window not woven: ' + r.reason, r.woven ? 'ok' : 'warn');
    // Every 5 s: stereo vs mono frames, so a session that keeps falling back shows up in the log.
    setInterval(() => {
      const s = handle.stats?.();
      if (s) console.info(`[visualizer] frames=${s.frames} monoFrames=${s.monoFrames} wovenState=${handle.wovenState ?? 'n/a'} buffer=${canvas.width}x${canvas.height}`);
    }, 5000);
  } else {
    console.info('[visualizer] no inline-3D session: rendering 2D');
    cover.remove();
    setStatus('2D preview. Open this page in the DisplayXR Browser on a 3D display for glasses-free depth.', '');
    requestAnimationFrame(onMonoFrame);
  }
}

// ---- UI: status, styles, sliders -------------------------------------------------------------
function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.dataset.kind = kind || '';
}

const styleBar = $('styles');
for (const [i, S] of STYLES.entries()) {
  const b = document.createElement('button');
  b.className = 'chip';
  b.type = 'button';
  b.innerHTML = `<span class="key">${i + 1}</span><span><b>${S.meta.name}</b><small>${S.meta.blurb}</small></span>`;
  b.addEventListener('click', () => { requestStyle(i); });
  styleBar.appendChild(b);
}
function syncStyleButtons() {
  [...styleBar.children].forEach((b, i) => b.setAttribute('aria-pressed', String(i === styleIndex)));
  const u = new URL(location.href);
  u.searchParams.set('style', STYLES[styleIndex].meta.id);
  history.replaceState(null, '', u);
}

const varBar = $('variations');
function renderVariations() {
  const names = style?.constructor.variations || [];
  varBar.replaceChildren(...names.map((n, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = n;
    b.setAttribute('aria-pressed', String(i === variation));
    b.addEventListener('click', () => setVariation(i));
    return b;
  }));
}
const varyBox = $('auto-vary');
varyBox.checked = autoVary;
varyBox.addEventListener('change', () => { autoVary = varyBox.checked; varClock = 0; });

const autoBox = $('auto');
autoBox.checked = auto;
autoBox.addEventListener('change', () => { auto = autoBox.checked; autoClock = 0; });
$('sensitivity').addEventListener('input', (e) => { audio.gain = +e.target.value; });
$('depth').addEventListener('input', (e) => { root.scale.z = +e.target.value; });
$('glow').value = glow;
$('glow').addEventListener('input', (e) => { glow = +e.target.value; applyBloom(); });
const qualitySel = $('quality');
qualitySel.value = quality;
qualitySel.addEventListener('change', () => {
  quality = qualitySel.value;
  store.set('quality', quality);
  composerSize = '';
  if (!QUALITY[quality]) { composer?.dispose?.(); composer = null; }
});

// ---- UI: sources -----------------------------------------------------------------------------
const sourceLabel = $('source-label');
function sourceChanged() {
  sourceLabel.textContent = audio.active ? 'Listening: ' + audio.sourceLabel : 'Not listening yet. The visuals are idling.';
  $('stop').disabled = !audio.active;
}
audio.onSourceEnded = sourceChanged;

/** Run a source action from a click; report failures in the source line. Returns success. */
async function run(fn) {
  try { await fn(); } catch (e) {
    if (e?.name !== 'NotAllowedError' && e?.name !== 'AbortError') console.error(e);
    sourceLabel.textContent = e?.name === 'NotAllowedError' ? 'Permission was declined.' : (e?.message || String(e));
    return false;
  }
  sourceChanged();
  return true;
}
// Listen to this tab (the in-page players). Call first thing in a click handler.
const listenTab = () => run(() => audio.captureThisTab());

$('src-system').addEventListener('click', () => run(() => audio.captureSystem()));
$('src-demo').addEventListener('click', () => run(() => audio.playDemo()).then(() => setTrack({ service: 'Demo', title: 'Demo loop', artist: 'Built-in lo-fi beat' })));
$('stop').addEventListener('click', () => { audio.stop(); sourceChanged(); });

const devSel = $('devices');
async function fillDevices() {
  const list = await audio.inputDevices();
  const cur = devSel.value;
  devSel.innerHTML = '<option value="">Default input</option>' +
    list.map((d, i) => `<option value="${escapeHtml(d.deviceId)}">${escapeHtml(d.label || `Input ${i + 1}`)}</option>`).join('');
  if ([...devSel.options].some((o) => o.value === cur)) devSel.value = cur;
}
$('src-input').addEventListener('click', () => run(async () => {
  await audio.captureInput(devSel.value);
  await fillDevices();   // labels are only available after permission
}));
devSel.addEventListener('change', () => { if (audio.sourceKind === 'input') run(() => audio.captureInput(devSel.value)); });
navigator.mediaDevices?.addEventListener?.('devicechange', fillDevices);
fillDevices().catch(() => {});

function playFile(f) {
  run(() => audio.playFile(f)).then((ok) => ok && setTrack({ service: 'File', title: f.name.replace(/\.[^.]+$/, ''), artist: '' }));
}
const fileIn = $('file');
fileIn.addEventListener('change', () => { if (fileIn.files[0]) playFile(fileIn.files[0]); });
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => {
  e.preventDefault();
  const f = [...(e.dataTransfer?.files || [])].find((x) => x.type.startsWith('audio/') || /\.(mp3|wav|ogg|flac|m4a|aac)$/i.test(x.name));
  if (f) playFile(f);
});

// ---- UI: tabs ----------------------------------------------------------------------------------
const tabs = [...document.querySelectorAll('[data-tab]')];
function showTab(name) {
  if (!tabs.some((t) => t.dataset.tab === name)) name = 'spotify';
  for (const t of tabs) t.setAttribute('aria-selected', String(t.dataset.tab === name));
  for (const p of document.querySelectorAll('[data-pane]')) p.hidden = p.dataset.pane !== name;
  store.set('tab', name);
}
for (const t of tabs) t.addEventListener('click', () => showTab(t.dataset.tab));

// ---- now playing + album colours -------------------------------------------------------------
let activeService = null;
let trackSeq = 0;
function setTrack(t, service) {
  if (service) activeService = service;
  const seq = ++trackSeq;
  $('np-title').textContent = t?.title || 'Nothing yet';
  $('np-artist').textContent = t ? [t.artist, t.album].filter(Boolean).join(' · ') : 'Connect a service or pick a source.';
  $('np-svc').textContent = t?.service || '';
  const img = $('art');
  img.hidden = !t?.art;
  $('art-ph').hidden = !!t?.art;
  if (t?.art) img.src = t.art;
  if (!t?.art) { applyArtPalette(null); return; }
  paletteFromImage(t.art)
    .then((p) => { if (seq === trackSeq) applyArtPalette(p); })
    .catch(() => { if (seq === trackSeq) applyArtPalette(null); });
}
function applyArtPalette(p) {
  artPalette = p;
  $('swatches').innerHTML = p ? p.map((c) => `<i style="background:rgb(${c.map((v) => Math.round(v * 255)).join(',')})"></i>`).join('') : '';
  style?.setPalette?.(matchArt ? p : null);
}
$('match-art').addEventListener('change', (e) => { matchArt = e.target.checked; style?.setPalette?.(matchArt ? artPalette : null); });
$('np-toggle').addEventListener('click', () => activeService?.toggle());
$('np-next').addEventListener('click', () => activeService?.next());
$('np-prev').addEventListener('click', () => activeService?.prev());

// ---- Spotify ---------------------------------------------------------------------------------
const spotify = new SpotifyService({
  clientId: SPOTIFY_CLIENT_ID || store.get('spotifyClientId') || '',
  onTrack: (t) => setTrack(t, t ? spotify : null),
  onStatus: setStatus,
  onState: () => renderSpotify(),
});
$('sp-redirect').textContent = spotify.redirectUri;
function renderSpotify() {
  $('sp-setup').hidden = !!spotify.clientId;
  $('sp-out').hidden = !spotify.clientId || spotify.connected;
  $('sp-in').hidden = !spotify.connected;
  const u = spotify.user;
  const note = $('sp-note');
  if (!u) note.textContent = '';
  else if (u.product !== 'premium') note.textContent = `Signed in as ${u.display_name || u.id}. Playing inside this page needs Premium. Play in the Spotify app on this PC and use "Listen to PC audio"; the now-playing card follows along either way.`;
  else note.textContent = `Signed in as ${u.display_name || u.id}. ${spotify.deviceId ? 'This page is the Spotify Connect speaker "3D Music Visualizer": pick it in the Spotify app on your phone, or press Play here & listen.' : 'Starting the in-page Spotify player…'}${spotify.activeDevice ? ` Playing on: ${spotify.activeDevice}.` : ''}`;
  $('sp-here').disabled = !spotify.deviceId;
}
$('sp-client-save').addEventListener('click', () => {
  const id = $('sp-client').value.trim();
  if (!/^[0-9a-f]{32}$/i.test(id)) { setStatus('That doesn\'t look like a Spotify Client ID (32 hex characters).', 'warn'); return; }
  store.set('spotifyClientId', id);
  spotify.clientId = id;
  renderSpotify();
});
$('sp-connect').addEventListener('click', () => spotify.signIn().catch((e) => setStatus(e.message, 'warn')));
$('sp-out-btn').addEventListener('click', () => { spotify.signOut(); renderSpotify(); });
$('sp-here').addEventListener('click', async () => {
  spotify.player?.activateElement?.();       // unlocks playback while the click still counts
  await listenTab();
  try { await spotify.playHere(); activeService = spotify; } catch (e) { setStatus(e.message, 'warn'); }
});
$('sp-listen-pc').addEventListener('click', () => { activeService = spotify; run(() => audio.captureSystem()); });
$('sp-play').addEventListener('click', async () => {
  spotify.player?.activateElement?.();
  if (spotify.deviceId && audio.sourceKind !== 'tab' && audio.sourceKind !== 'system') await listenTab();
  try { await spotify.playLink($('sp-link').value); activeService = spotify; } catch (e) { setStatus(e.message, 'warn'); }
});

// ---- YouTube ---------------------------------------------------------------------------------
const youtube = new YouTubeService({
  host: 'yt-player',
  onTrack: (t) => setTrack(t, youtube),
  onStatus: setStatus,
  onState: () => {},
});
$('yt-play').addEventListener('click', async () => {
  await listenTab();
  try {
    $('yt-wrap').hidden = false;
    await youtube.load($('yt-link').value, true);
    activeService = youtube;
  } catch (e) { setStatus(e.message, 'warn'); }
});
$('yt-listen').addEventListener('click', () => { activeService = youtube; listenTab(); });

// ---- full view, keys, meter ------------------------------------------------------------------
function setFill(on) {
  document.body.classList.toggle('fill', on);
  $('fill').setAttribute('aria-pressed', String(on));
}
$('fill').addEventListener('click', () => setFill(!document.body.classList.contains('fill')));
$('exit-fill').addEventListener('click', () => setFill(false));

addEventListener('keydown', (e) => {
  if (e.target.closest?.('input, select, textarea, button')) return;
  if (e.key >= '1' && e.key <= String(STYLES.length)) requestStyle(+e.key - 1);
  else if (e.key === 'ArrowRight') requestStyle(styleIndex + 1);
  else if (e.key === 'ArrowLeft') requestStyle(styleIndex - 1);
  else if (e.key === ' ') { e.preventDefault(); activeService?.toggle(); }
  else if (e.key === 'a' || e.key === 'A') { autoBox.checked = auto = !auto; autoClock = 0; }
  else if (e.key === 'v' || e.key === 'V') setVariation(variation + 1);
  else if (e.key === 'f' || e.key === 'F') setFill(!document.body.classList.contains('fill'));
  else if (e.key === 'Escape') setFill(false);
});

const meter = $('meter');
const bpmEl = $('bpm');
let meterN = 0;
function meterTick() {
  if ((meterN++ & 1) === 0) {
    meter.style.setProperty('--l', audio.level.toFixed(3));
    meter.classList.toggle('beat', audio.beat > 0.6);
  }
  if ((meterN & 31) === 0) bpmEl.textContent = audio.active && audio.bpm ? `${Math.round(audio.bpm)} BPM` : '';
}

function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }

// ---- start -------------------------------------------------------------------------------------
showTab(params.has('code') ? 'spotify' : (params.get('tab') || store.get('tab') || 'spotify'));
sourceChanged();
renderSpotify();
boot();
spotify.init().catch((e) => setStatus('Spotify: ' + e.message, 'warn'));
// ?demo starts the demo loop at once (headless checks; browsers allow it when autoplay is permitted).
if (params.has('demo')) audio.playDemo().then(() => { sourceChanged(); setTrack({ service: 'Demo', title: 'Demo loop', artist: 'Built-in lo-fi beat' }); }, () => {});
// ?art=<image url> tints the styles from that image (for checking album-colour matching).
if (params.get('art')) setTrack({ service: 'Test', title: 'Album colours', artist: '', art: params.get('art') });
