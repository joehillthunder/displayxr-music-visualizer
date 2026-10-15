// Album-art palette: the five most characterful colours of a cover image, for tinting the styles
// to match whatever is playing.
//
// Pixels are binned in a coarse HSV histogram; each bin scores by how many pixels it holds,
// weighted toward saturated, mid-bright colours (a black-and-white cover still yields a usable,
// if muted, palette). The top bins are picked greedily so the five colours stay distinct in hue.

export async function paletteFromImage(url) {
  const img = await loadImage(url);
  const S = 64;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0, S, S);
  const px = g.getImageData(0, 0, S, S).data;   // throws if the image is not CORS-clean

  const bins = new Map();
  for (let i = 0; i < px.length; i += 4) {
    const [h, s, v] = rgbToHsv(px[i] / 255, px[i + 1] / 255, px[i + 2] / 255);
    const key = s < 0.12 ? `g${Math.round(v * 6)}` : `${Math.round(h * 18) % 18}:${Math.round(s * 3)}:${Math.round(v * 4)}`;
    let b = bins.get(key);
    if (!b) bins.set(key, b = { r: 0, g: 0, b: 0, n: 0, h, s, v });
    b.r += px[i]; b.g += px[i + 1]; b.b += px[i + 2]; b.n++;
  }
  const scored = [...bins.values()].map((b) => {
    const r = b.r / b.n / 255, gg = b.g / b.n / 255, bb = b.b / b.n / 255;
    const [h, s, v] = rgbToHsv(r, gg, bb);
    const vivid = 0.25 + s * 1.5;
    const midtone = 1 - Math.abs(v - 0.6) * 1.1;
    return { rgb: [r, gg, bb], h, s, v, score: Math.sqrt(b.n) * vivid * Math.max(0.1, midtone) };
  }).sort((a, b) => b.score - a.score);

  const picked = [];
  for (const cand of scored) {
    if (picked.every((p) => hueDist(p.h, cand.h) > 0.07 || Math.abs(p.v - cand.v) > 0.35)) picked.push(cand);
    if (picked.length === 5) break;
  }
  while (picked.length < 5) picked.push(scored[picked.length % scored.length]);
  // Lift dark or grey picks so they read as light on a black backdrop.
  return picked.map(({ h, s, v }) => hsvToRgb(h, Math.min(1, s * 1.15 + 0.05), Math.max(0.55, Math.min(1, v * 1.15))));
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Album art could not be loaded'));
    img.src = url;
  });
}

function hueDist(a, b) { const d = Math.abs(a - b); return Math.min(d, 1 - d); }

function rgbToHsv(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6; if (h < 0) h += 1;
  }
  return [h, max ? d / max : 0, max];
}

function hsvToRgb(h, s, v) {
  const f = (n) => { const k = (n + h * 6) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return [f(5), f(3), f(1)];
}
