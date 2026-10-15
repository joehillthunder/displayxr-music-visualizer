// Shared bits for the visualization styles.
//
// Every style is a class with the same shape:
//
//   static meta = { id, name, blurb }
//   static bloom = { strength, radius, threshold }   glow settings for the bloom pass
//   static palette = [5 x '#rrggbb']                 the style's own colours
//   static variations = ['Name', ...]                layouts the style can blend between
//   static drift = { yaw, pitch }                    how far main.js slowly sways the scene (radians)
//   constructor(THREE)      builds this.group (added to the scene by main.js)
//   setVariation(i)         start blending to layout i
//   update(audio, dt)       advance one frame from the AudioEngine's features
//   setPalette(rgb[5]|null) blend toward album-art colours (sRGB 0..1 triples), or back to its own
//   beforeRender(vpHeight)  optional: called before each eye with that eye's viewport height in
//                           buffer pixels (point sprites need it to size themselves in metres)
//   dispose()
//
// Interaction (js/interact.js), all optional:
//   targets                 Flyers pools the viewer can tap to pop and swipe to swat
//   popped(pool, i, info)   called when the viewer has popped object i of a pool (already removed);
//                           info = { x, y, z, size, color } in the pool's local space
//   tap(ray, fx)            the viewer tapped and hit nothing poppable. `ray` is a world-space
//                           THREE.Ray (fx.toLocal(ray, obj) converts it); return true if the style
//                           reacted, otherwise the glass ripples where the tap landed
//   hover(ray, dt)          each frame while the pointer is over the canvas (world-space ray)
//   cursorTargets           meshes that count as content for the depth cursor
//
// Units are metres on a virtual display 0.12 m tall (main.js passes virtualDisplayHeight 0.12).
// z = 0 is the glass: +z comes out toward the viewer, -z goes behind it. At 16:9 the visible
// window at z = 0 is about 0.213 m x 0.12 m.
//
// Colour: shaders author colours in sRGB (as picked), convert with toLinear() and end with
// #include <colorspace_fragment>, so they look the same whether drawn through the bloom
// composer (linear HDR target) or straight to the canvas. Values above 1 glow under bloom.

export const FRAME_W = 0.213;
export const FRAME_H = 0.12;

export const COLOR_GLSL = /* glsl */`
  vec3 toLinear(vec3 c) { return pow(max(c, vec3(0.0)), vec3(2.2)); }
  vec3 hsv(float h, float s, float v) {
    vec3 k = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
    return v * mix(vec3(1.0), k, s);
  }
  uniform vec3 uPal[5];
  // Sample the 5-colour palette as a smooth loop, t in 0..1.
  vec3 palette(float t) {
    t = fract(t) * 5.0;
    int i = int(floor(t));
    float f = smoothstep(0.0, 1.0, fract(t));
    vec3 a = uPal[0], b = uPal[1];
    if (i == 1) { a = uPal[1]; b = uPal[2]; }
    else if (i == 2) { a = uPal[2]; b = uPal[3]; }
    else if (i == 3) { a = uPal[3]; b = uPal[4]; }
    else if (i == 4) { a = uPal[4]; b = uPal[0]; }
    return mix(a, b, f);
  }
`;

// Vertex-shader size for point sprites given in METRES, so they stay the right size in each
// eye's off-axis projection. projectionMatrix[1][1] is the vertical focal scale.
export const POINT_SIZE_GLSL = /* glsl */`
  uniform float uViewportH;
  float pointPx(float metres, vec4 mvPosition) {
    return metres * projectionMatrix[1][1] * 0.5 * uViewportH / max(0.001, -mvPosition.z);
  }
`;

// Fade for points that come out of the glass: they shrink away near the window's edges (where
// the frame would cut them off, a "window violation" that breaks the 3D) and before POP_MAX.
// `p` is the point in the style's space (metres, z = 0 on the glass). Same rule as Flyers.
export const EDGE_FADE_GLSL = /* glsl */`
  float edgeFade(vec3 p) {
    if (p.z <= 0.0) return 1.0;
    float ex = clamp((0.1 - abs(p.x)) / 0.025, 0.0, 1.0);
    float ey = clamp((0.056 - abs(p.y)) / 0.015, 0.0, 1.0);
    float ez = 1.0 - clamp((p.z - 0.0375) / 0.0125, 0.0, 1.0);
    return min(ex, ey) * ez;
  }
`;

// Ashima/Stefan Gustavson 3D simplex noise (MIT).
export const NOISE_GLSL = /* glsl */`
  vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
  vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
  vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
  vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
  float snoise(vec3 v){
    const vec2 C=vec2(1.0/6.0,1.0/3.0); const vec4 D=vec4(0.0,0.5,1.0,2.0);
    vec3 i=floor(v+dot(v,C.yyy)); vec3 x0=v-i+dot(i,C.xxx);
    vec3 g=step(x0.yzx,x0.xyz); vec3 l=1.0-g; vec3 i1=min(g.xyz,l.zxy); vec3 i2=max(g.xyz,l.zxy);
    vec3 x1=x0-i1+C.xxx; vec3 x2=x0-i2+C.yyy; vec3 x3=x0-D.yyy;
    i=mod289(i);
    vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
    float n_=0.142857142857; vec3 ns=n_*D.wyz-D.xzx;
    vec4 j=p-49.0*floor(p*ns.z*ns.z); vec4 x_=floor(j*ns.z); vec4 y_=floor(j-7.0*x_);
    vec4 x=x_*ns.x+ns.yyyy; vec4 y=y_*ns.x+ns.yyyy; vec4 h=1.0-abs(x)-abs(y);
    vec4 b0=vec4(x.xy,y.xy); vec4 b1=vec4(x.zw,y.zw);
    vec4 s0=floor(b0)*2.0+1.0; vec4 s1=floor(b1)*2.0+1.0; vec4 sh=-step(h,vec4(0.0));
    vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
    vec3 p0=vec3(a0.xy,h.x); vec3 p1=vec3(a0.zw,h.y); vec3 p2=vec3(a1.xy,h.z); vec3 p3=vec3(a1.zw,h.w);
    vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
    p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;
    vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0); m=m*m;
    return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
  }
`;

export const QUAD_VERT = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }';

export function hexRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}

/**
 * The live 5-colour palette of a style: starts at the style's own colours and eases toward
 * whatever setPalette() asks for, so album changes fade in rather than snap.
 * `uniform` is a ready-made { value: Vector3[5] } for ShaderMaterials (sRGB components).
 */
export class Palette {
  constructor(THREE, hexes) {
    this.base = hexes.map(hexRgb);
    this.cur = this.base.map((c) => c.slice());
    this.target = this.base;
    this.uniform = { value: this.cur.map((c) => new THREE.Vector3(...c)) };
    this._c = new THREE.Color();
    this.T = THREE;
  }
  set(rgbs) { this.target = rgbs && rgbs.length >= 5 ? rgbs : this.base; }
  update(dt) {
    const k = 1 - Math.exp(-dt * 2.5);
    for (let i = 0; i < 5; i++) {
      for (let j = 0; j < 3; j++) this.cur[i][j] += (this.target[i][j] - this.cur[i][j]) * k;
      this.uniform.value[i].set(...this.cur[i]);
    }
  }
  /** Palette entry i as a THREE.Color (converted from sRGB for built-in materials). */
  color(i, out = this._c) { const c = this.cur[i % 5]; return out.setRGB(c[0], c[1], c[2], this.T.SRGBColorSpace); }
}

// ---- depth helpers -------------------------------------------------------------------------------

// How far in front of the glass anything may come, in metres at the 0.12 m virtual display height.
// Past this, pop-out stops being comfortable and starts to double.
export const POP_MAX = 0.05;

/**
 * Eases a set of numbers toward targets, so switching a style's variation blends its layout over
 * a few seconds instead of jumping.
 */
export class Blend {
  constructor(values) { this.cur = { ...values }; this.target = { ...values }; }
  to(values) { Object.assign(this.target, values); }
  update(dt, rate = 0.9) {
    const k = 1 - Math.exp(-dt * rate);
    for (const key in this.target) this.cur[key] += (this.target[key] - this.cur[key]) * k;
    return this.cur;
  }
}

/**
 * A pool of short-lived objects that fly out of the screen: spawn() one with a position and a
 * velocity, and it tumbles along, grows in, shrinks out at the end of its life, and slows and
 * fades before it passes POP_MAX. Objects that come in front of the glass also shrink near the
 * window's edges, where the frame would cut them off (a "window violation" that breaks the 3D).
 * One InstancedMesh, so hundreds cost one draw call.
 */
export class Flyers {
  constructor(THREE, geometry, material, count) {
    this.mesh = new THREE.InstancedMesh(geometry, material, count);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.n = count;
    this.next = 0;
    this.drag = 0.8;
    this.gravity = 0;
    this.p = new Float32Array(count * 3);
    this.v = new Float32Array(count * 3);
    this.rot = new Float32Array(count * 3);
    this.spin = new Float32Array(count * 3);
    this.life = new Float32Array(count);
    this.maxLife = new Float32Array(count).fill(1);
    this.size = new Float32Array(count);
    this.col = Array.from({ length: count }, () => new THREE.Color());
    this.m = new THREE.Matrix4();
    this.q = new THREE.Quaternion();
    this.e = new THREE.Euler();
    this.pos = new THREE.Vector3();
    this.scl = new THREE.Vector3();
    this.c = new THREE.Color();
    this.shown = new Float32Array(count);   // drawn scale as a share of size, for hit tests
    this.tmp = new THREE.Vector3();
    this.m.makeScale(0, 0, 0);
    for (let i = 0; i < count; i++) { this.mesh.setMatrixAt(i, this.m); this.mesh.setColorAt(i, this.c.setRGB(0, 0, 0)); }
  }

  // ---- interaction (see js/interact.js) ----
  // Rays are THREE.Rays in this mesh's local space; main.js converts the pointer ray for each pool.

  /**
   * The live object nearest along `ray` whose centre passes within its drawn radius plus `reach`
   * of the ray (small things get a little extra so they can be hit), or -1.
   */
  hit(ray, reach = 0.004) {
    let best = -1, bestT = Infinity;
    for (let i = 0; i < this.n; i++) {
      if (this.life[i] <= 0 || this.shown[i] < 0.15) continue;
      const o = i * 3;
      this.pos.set(this.p[o], this.p[o + 1], this.p[o + 2]);
      const t = this.tmp.subVectors(this.pos, ray.origin).dot(ray.direction);
      if (t <= 0 || t >= bestT) continue;
      const r = this.size[i] * this.shown[i] + reach;
      if (ray.distanceSqToPoint(this.pos) < r * r) { best = i; bestT = t; }
    }
    return best;
  }

  /** Remove object i at once and report where it was: { x, y, z, size, color }. */
  pop(i) {
    const o = i * 3;
    const out = { x: this.p[o], y: this.p[o + 1], z: this.p[o + 2], size: this.size[i] * this.shown[i], color: this.col[i].clone() };
    this.life[i] = 0;
    this.shown[i] = 0;
    this.m.makeScale(0, 0, 0);
    this.mesh.setMatrixAt(i, this.m);
    this.mesh.instanceMatrix.needsUpdate = true;
    return out;
  }

  /** Swat: add velocity (vx, vy, vz) to every live object within `radius` of the ray, more near it. */
  push(ray, vx, vy, vz, radius = 0.012) {
    let n = 0;
    for (let i = 0; i < this.n; i++) {
      if (this.life[i] <= 0) continue;
      const o = i * 3;
      const d = Math.sqrt(ray.distanceSqToPoint(this.pos.set(this.p[o], this.p[o + 1], this.p[o + 2])));
      if (d > radius) continue;
      const k = 1 - d / radius;
      this.v[o] += vx * k; this.v[o + 1] += vy * k; this.v[o + 2] += vz * k;
      this.spin[o] += rand(-8, 8) * k; this.spin[o + 1] += rand(-8, 8) * k;
      n++;
    }
    return n;
  }

  spawn(x, y, z, vx, vy, vz, { life = 1.5, size = 0.003, color = null, spin = 3, rot = null } = {}) {
    const i = this.next = (this.next + 1) % this.n;
    const o = i * 3;
    this.p[o] = x; this.p[o + 1] = y; this.p[o + 2] = z;
    this.v[o] = vx; this.v[o + 1] = vy; this.v[o + 2] = vz;
    if (rot) { this.rot[o] = rot[0]; this.rot[o + 1] = rot[1]; this.rot[o + 2] = rot[2]; }
    else { this.rot[o] = Math.random() * 6.28; this.rot[o + 1] = Math.random() * 6.28; this.rot[o + 2] = Math.random() * 6.28; }
    this.spin[o] = rand(-spin, spin); this.spin[o + 1] = rand(-spin, spin); this.spin[o + 2] = rand(-spin, spin);
    this.life[i] = this.maxLife[i] = life;
    this.size[i] = size;
    if (color) this.col[i].copy(color);
    return i;
  }

  update(dt, brightness = 1) {
    const drag = Math.exp(-dt * this.drag);
    for (let i = 0; i < this.n; i++) {
      if (this.life[i] <= 0) { this.shown[i] = 0; continue; }
      this.life[i] -= dt;
      const o = i * 3;
      this.v[o + 1] -= this.gravity * dt;
      for (let k = 0; k < 3; k++) {
        this.p[o + k] += this.v[o + k] * dt;
        this.v[o + k] *= drag;
        this.rot[o + k] += this.spin[o + k] * dt;
      }
      const z = this.p[o + 2];
      let fade = 1;
      if (z > POP_MAX * 0.75) {
        this.v[o + 2] *= Math.exp(-dt * 6);                                      // brake
        fade = Math.max(0, 1 - (z - POP_MAX * 0.75) / (POP_MAX * 0.25));
      }
      if (z > 0) {                                                               // keep pop-out off the edges
        const ex = Math.min(1, Math.max(0, (0.1 - Math.abs(this.p[o])) / 0.025));
        const ey = Math.min(1, Math.max(0, (0.056 - Math.abs(this.p[o + 1])) / 0.015));
        fade *= Math.min(ex, ey);
      }
      const t = Math.max(0, this.life[i] / this.maxLife[i]);                   // 1 → 0 over the life
      const s = this.size[i] * Math.min(1, (1 - t) * 8) * Math.min(1, t * 3.5) * fade;
      this.shown[i] = this.size[i] > 0 ? s / this.size[i] : 0;
      this.e.set(this.rot[o], this.rot[o + 1], this.rot[o + 2]);
      this.m.compose(this.pos.set(this.p[o], this.p[o + 1], z), this.q.setFromEuler(this.e), this.scl.set(s, s, s));
      this.mesh.setMatrixAt(i, this.m);
      this.mesh.setColorAt(i, this.c.copy(this.col[i]).multiplyScalar(brightness * (0.5 + t * 0.7)));
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

/** Average of bands[from..to). */
export function bandAvg(bands, from, to) {
  let s = 0;
  for (let i = from; i < to; i++) s += bands[i];
  return s / Math.max(1, to - from);
}

/** Resample a spectrum to `n` values into `out`. */
export function resample(bands, n, out) {
  const step = bands.length / n;
  for (let i = 0; i < n; i++) {
    const a = i * step, b = (i + 1) * step;
    out[i] = b - a >= 1 ? bandAvg(bands, Math.floor(a), Math.ceil(b)) : bands[Math.min(bands.length - 1, Math.floor(a))];
  }
  return out;
}

export function rand(lo, hi) { return lo + Math.random() * (hi - lo); }

/** Dispose every geometry and material under an object. */
export function disposeTree(obj) {
  obj.traverse((o) => {
    o.geometry?.dispose();
    const m = o.material;
    if (Array.isArray(m)) m.forEach((x) => x.dispose()); else m?.dispose();
  });
}
