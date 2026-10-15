// DisplayXR Music Visualizer: app shell.
//
// One three.js renderer on one persistent <canvas> for the life of the page (woven-canvas rules
// 1-3). In the DisplayXR Browser on a 3D display the canvas is an inline-3D window: each frame
// we render the current style twice, once per eye, from the views the session hands us. In any
// other browser the same scene renders once, flat.
//
// Styles are swapped INSIDE the canvas (a quick fade through black), never by replacing it.

import * as THREE from 'three';
import { createInline3D } from '@displayxr/inline3d';
import { EyeCamera, EdgeFeather } from '@displayxr/inline3d/three';
import { AudioEngine } from './audio.js';
import LofiStyle from './styles/lofi.js';
import ImpressionistStyle from './styles/impressionist.js';
import SynthwaveStyle from './styles/synthwave.js';
import NebulaStyle from './styles/nebula.js';
import OrbStyle from './styles/orb.js';

const STYLES = [LofiStyle, ImpressionistStyle, SynthwaveStyle, NebulaStyle, OrbStyle];
const VIRTUAL_DISPLAY_HEIGHT = 0.12;   // the scenes are authored in metres for a 12 cm-tall window
const AUTO_SECONDS = 40;

const $ = (id) => document.getElementById(id);
const canvas = $('stage');
const cover = $('cover');
const statusEl = $('status');
const params = new URLSearchParams(location.search);

// ---- renderer --------------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({
  canvas, antialias: true, alpha: true, preserveDrawingBuffer: true, powerPreference: 'high-performance',
});
// Opaque clear in the page colour: additive styles then glow against a solid backdrop rather
// than punching alpha holes in a transparent canvas. EdgeFeather still fades the edges out.
renderer.setClearColor(0x07060d, 1);
renderer.setPixelRatio(1);              // getViewport() is in buffer pixels; see hello-cube
renderer.autoClear = false;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const root = new THREE.Group();          // depth slider scales this along z
scene.add(root);

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

function mountStyle(i) {
  if (style) { root.remove(style.group); style.dispose(); }
  styleIndex = i;
  style = new STYLES[i](THREE);
  root.add(style.group);
  autoClock = 0;
  syncStyleButtons();
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
  style.update(audio, dt);
  meterTick();
}

// ---- drawing ---------------------------------------------------------------------------------
function drawEye(cam, vp) {
  renderer.setViewport(vp.x, vp.y, vp.width, vp.height);
  renderer.setScissor(vp.x, vp.y, vp.width, vp.height);
  style.beforeRender?.(vp.height);
  renderer.render(scene, cam);
  if (fade > 0.001) renderer.render(fadeScene, fadeCam);
  feather.render(renderer, vp);
}

function drawStereo(eyes) {
  renderer.clear();
  renderer.setScissorTest(true);
  for (const e of eyes) drawEye(eye.setFromMatrices(e.proj, e.xf), e.vp);
  renderer.setScissorTest(false);
}

function drawMono() {
  const w = renderer.domElement.width, h = renderer.domElement.height;
  renderer.clear();
  renderer.setScissorTest(true);
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
      rectCover: 'auto',          // covers the canvas while Fill window resizes it
      onLayerLost: () => {        // fall back to flat rendering
        sbs = false; lastGood = null; sizeCanvas(); requestAnimationFrame(onMonoFrame);
        setStatus('3D layer lost: showing 2D', 'warn');
      },
    });
    const r = await handle.firstWoven;
    cover.remove();               // hard cut, never a fade
    setStatus(r.woven ? 'Glasses-free 3D on. Move your head to look around.' : '3D window not woven: ' + r.reason, r.woven ? 'ok' : 'warn');
  } else {
    cover.remove();
    setStatus('2D preview. Open this page in the DisplayXR Browser on a 3D display for glasses-free depth.', '');
    requestAnimationFrame(onMonoFrame);
  }
}

// ---- UI --------------------------------------------------------------------------------------
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

const autoBox = $('auto');
autoBox.checked = auto;
autoBox.addEventListener('change', () => { auto = autoBox.checked; autoClock = 0; });

const sens = $('sensitivity');
sens.addEventListener('input', () => { audio.gain = +sens.value; });
const depth = $('depth');
depth.addEventListener('input', () => { root.scale.z = +depth.value; });

const sourceLabel = $('source-label');
function sourceChanged() {
  sourceLabel.textContent = audio.active ? audio.sourceLabel : 'No source. The visuals are idling.';
  $('stop').disabled = !audio.active;
}
audio.onSourceEnded = sourceChanged;

async function run(fn) {
  try { await fn(); } catch (e) {
    if (e?.name !== 'NotAllowedError' && e?.name !== 'AbortError') console.error(e);
    sourceLabel.textContent = e?.name === 'NotAllowedError' ? 'Permission was declined.' : (e?.message || String(e));
    return;
  }
  sourceChanged();
}

$('src-system').addEventListener('click', () => run(() => audio.captureSystem()));
$('src-demo').addEventListener('click', () => run(() => audio.playDemo()));
$('stop').addEventListener('click', () => { audio.stop(); sourceChanged(); });

const devSel = $('devices');
async function fillDevices() {
  const list = await audio.inputDevices();
  const cur = devSel.value;
  devSel.innerHTML = '<option value="">Default input</option>' +
    list.map((d, i) => `<option value="${d.deviceId}">${escapeHtml(d.label || `Input ${i + 1}`)}</option>`).join('');
  if ([...devSel.options].some((o) => o.value === cur)) devSel.value = cur;
}
$('src-input').addEventListener('click', () => run(async () => {
  await audio.captureInput(devSel.value);
  await fillDevices();   // labels are only available after permission
}));
devSel.addEventListener('change', () => { if (audio.stream && audio.sourceLabel !== 'System / tab audio') run(() => audio.captureInput(devSel.value)); });
navigator.mediaDevices?.addEventListener?.('devicechange', fillDevices);
fillDevices().catch(() => {});

const fileIn = $('file');
fileIn.addEventListener('change', () => { if (fileIn.files[0]) run(() => audio.playFile(fileIn.files[0])); });
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => {
  e.preventDefault();
  const f = [...(e.dataTransfer?.files || [])].find((x) => x.type.startsWith('audio/') || /\.(mp3|wav|ogg|flac|m4a|aac)$/i.test(x.name));
  if (f) run(() => audio.playFile(f));
});

// Fill window: the stage takes the whole viewport. The canvas keeps its identity; the SDK's
// rectCover hides it while the new rect is re-joined.
function setFill(on) {
  document.body.classList.toggle('fill', on);
  $('fill').setAttribute('aria-pressed', String(on));
}
$('fill').addEventListener('click', () => setFill(!document.body.classList.contains('fill')));
$('exit-fill').addEventListener('click', () => setFill(false));

addEventListener('keydown', (e) => {
  if (e.target.closest?.('input, select, textarea')) return;
  if (e.key >= '1' && e.key <= String(STYLES.length)) requestStyle(+e.key - 1);
  else if (e.key === 'ArrowRight') requestStyle(styleIndex + 1);
  else if (e.key === 'ArrowLeft') requestStyle(styleIndex - 1);
  else if (e.key === 'a' || e.key === 'A') { autoBox.checked = auto = !auto; autoClock = 0; }
  else if (e.key === 'f' || e.key === 'F') setFill(!document.body.classList.contains('fill'));
  else if (e.key === 'Escape') setFill(false);
});

// Level meter (DOM, outside the canvas).
const meter = $('meter');
let meterN = 0;
function meterTick() {
  if ((meterN++ & 1) === 0) {
    meter.style.setProperty('--l', audio.level.toFixed(3));
    meter.classList.toggle('beat', audio.beat > 0.6);
  }
}

function escapeHtml(s) { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }

sourceChanged();
boot();
// ?demo starts the demo loop at once (headless checks; browsers allow it when autoplay is permitted).
if (params.has("demo")) audio.playDemo().then(sourceChanged, () => {});
