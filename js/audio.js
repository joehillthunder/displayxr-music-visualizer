// Audio input and analysis.
//
// One AudioContext and one AnalyserNode for the life of the page. A source (captured system or
// tab audio, a microphone or line-in, a local file, or the built-in demo loop) is connected to
// the analyser. Each animation frame, update() turns the FFT into a small set of features every
// style reads:
//
//   bands[N]  log-spaced spectrum, 0..1, smoothed (N = BAND_COUNT)
//   bass, mid, treble, level   band energies, 0..1, smoothed
//   beat      1 on a detected kick, decaying to 0 over ~0.25 s
//   beatCount number of beats so far (styles use it to alternate things)
//   centroid  spectral "brightness", 0..1
//   time      seconds of audio-driven time (runs faster when the music is louder)
//
// With no source connected the features idle at a low, slowly breathing level so every style
// still moves.

export const BAND_COUNT = 64;

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.analyser = null;
    this.source = null;          // the current source node
    this.stream = null;          // MediaStream we own (capture / mic), stopped on switch
    this.mediaEl = null;         // <audio> element for file playback
    this.demo = null;            // DemoLoop when the demo is playing
    this.gain = 1;               // user sensitivity
    this.sourceLabel = 'none';
    this.onSourceEnded = null;

    this.bands = new Float32Array(BAND_COUNT);
    this.bass = 0; this.mid = 0; this.treble = 0; this.level = 0;
    this.beat = 0; this.beatCount = 0; this.centroid = 0.4;
    this.time = 0;

    this._bassHist = new Float32Array(43);   // ~0.7 s of bass energy at 60 fps
    this._histI = 0;
    this._sinceBeat = 1;
    this._autoGain = 1;
  }

  get active() { return !!this.source; }

  _ensureContext() {
    if (this.ctx) return;
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 4096;
    this.analyser.smoothingTimeConstant = 0.55;
    this.analyser.minDecibels = -90;
    this.analyser.maxDecibels = -15;
    this._freq = new Uint8Array(this.analyser.frequencyBinCount);
    this._edges = logBandEdges(this.analyser.frequencyBinCount, this.ctx.sampleRate, BAND_COUNT);
  }

  async _resume() {
    this._ensureContext();
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }

  stop() {
    if (this.source) { try { this.source.disconnect(); } catch {} }
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    if (this.mediaEl) { this.mediaEl.pause(); URL.revokeObjectURL(this.mediaEl.src); }
    if (this.demo) this.demo.stop();
    this.source = this.stream = this.mediaEl = this.demo = null;
    this.sourceLabel = 'none';
  }

  _useStream(stream, label) {
    const track = stream.getAudioTracks()[0];
    this.stream = stream;
    this.source = this.ctx.createMediaStreamSource(new MediaStream([track]));
    // Captured audio goes to the analyser only, never the speakers: it is already playing.
    this.source.connect(this.analyser);
    this.sourceLabel = label;
    track.addEventListener('ended', () => {
      if (this.stream === stream) { this.stop(); this.onSourceEnded?.(); }
    });
  }

  /** Audio from another tab, an app, or the whole system (Spotify, YouTube, AirPlay/Bluetooth receivers…). */
  async captureSystem() {
    await this._resume();
    // Chromium needs a video track to offer audio. "Entire screen" + "Also share system audio"
    // captures everything the PC plays; a tab share captures that tab only.
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 1, width: 320, height: 180 },
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      systemAudio: 'include',
      selfBrowserSurface: 'exclude',
      preferCurrentTab: false,
    });
    if (!stream.getAudioTracks().length) {
      for (const t of stream.getTracks()) t.stop();
      throw new Error('No audio was shared. Share again and turn on "Share system audio" (or "Share tab audio").');
    }
    // The video track is not used. Keep it running: on some Chromium builds stopping it ends
    // the whole share, audio included.
    this.stop();
    this._useStream(stream, 'System / tab audio');
  }

  /** A microphone, a USB interface, a "Stereo Mix" device, or line-in from a phone or streamer. */
  async captureInput(deviceId) {
    await this._resume();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: false, noiseSuppression: false, autoGainControl: false,
      },
    });
    this.stop();
    const label = stream.getAudioTracks()[0].label || 'Audio input';
    this._useStream(stream, label);
  }

  async inputDevices() {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === 'audioinput');
  }

  /** A local audio file, played through the speakers. */
  async playFile(file) {
    await this._resume();
    this.stop();
    const el = new Audio();
    el.src = URL.createObjectURL(file);
    el.loop = true;
    this.mediaEl = el;
    this.source = this.ctx.createMediaElementSource(el);
    this.source.connect(this.analyser);
    this.source.connect(this.ctx.destination);
    this.sourceLabel = file.name;
    await el.play();
  }

  /** A synthesized lo-fi loop, so the visuals can be tried without any music source. */
  async playDemo() {
    await this._resume();
    this.stop();
    this.demo = new DemoLoop(this.ctx);
    this.source = this.demo.output;
    this.source.connect(this.analyser);
    this.source.connect(this.ctx.destination);
    this.demo.start();
    this.sourceLabel = 'Demo loop';
  }

  /** Call once per animation frame. */
  update(dt) {
    dt = Math.min(dt, 0.1);
    const bands = this.bands;
    let bass = 0, mid = 0, treble = 0;

    if (this.source) {
      this.analyser.getByteFrequencyData(this._freq);
      const f = this._freq, e = this._edges;
      let num = 0, den = 0, peak = 0;
      for (let i = 0; i < BAND_COUNT; i++) {
        let s = 0;
        for (let k = e[i]; k < e[i + 1]; k++) s = Math.max(s, f[k]);
        // Tilt: high bands carry less energy in music; lift them so the spectrum reads level.
        const v = Math.min(1, (s / 255) * (0.85 + 0.5 * i / BAND_COUNT) * this.gain * this._autoGain);
        bands[i] += (v - bands[i]) * (v > bands[i] ? 0.6 : 0.18);
        num += v * i; den += v; peak = Math.max(peak, v);
      }
      bass = avg(bands, 0, 8); mid = avg(bands, 8, 36); treble = avg(bands, 36, BAND_COUNT);
      this.centroid += ((den > 0 ? num / den / BAND_COUNT : 0.4) - this.centroid) * 0.05;
      // Slow automatic gain so quiet captures and loud files both fill the range.
      const target = peak > 0.02 ? clamp(0.8 / peak, 0.6, 3) : this._autoGain;
      this._autoGain += (target - this._autoGain) * dt * 0.25;
    } else {
      // Idle: a gentle breathing so the scene is alive before any source is chosen.
      const t = performance.now() / 1000;
      for (let i = 0; i < BAND_COUNT; i++) {
        const v = 0.12 + 0.08 * Math.sin(t * 0.9 + i * 0.35) * Math.sin(t * 0.37 + i * 0.11);
        bands[i] += (v * (1 - i / BAND_COUNT * 0.5) - bands[i]) * 0.1;
      }
      bass = 0.15 + 0.1 * Math.sin(t * 1.6) ** 8; mid = 0.12; treble = 0.08;
    }

    const k = 1 - Math.exp(-dt * 14);
    this.bass += (bass - this.bass) * k;
    this.mid += (mid - this.mid) * k;
    this.treble += (treble - this.treble) * k;
    this.level = this.bass * 0.5 + this.mid * 0.35 + this.treble * 0.15;

    // Beat: bass energy jumps clearly above its recent average, at most ~4 per second.
    const h = this._bassHist;
    let mean = 0; for (let i = 0; i < h.length; i++) mean += h[i]; mean /= h.length;
    let varc = 0; for (let i = 0; i < h.length; i++) varc += (h[i] - mean) ** 2; varc /= h.length;
    h[this._histI = (this._histI + 1) % h.length] = bass;
    this._sinceBeat += dt;
    const threshold = mean + Math.max(0.06, 1.4 * Math.sqrt(varc));
    if (bass > threshold && bass > 0.18 && this._sinceBeat > 0.24) {
      this.beat = 1; this.beatCount++; this._sinceBeat = 0;
    } else {
      this.beat *= Math.exp(-dt * 9);
    }

    this.time += dt * (0.4 + this.level * 1.6);
  }
}

function avg(a, from, to) { let s = 0; for (let i = from; i < to; i++) s += a[i]; return s / (to - from); }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// FFT bin edges for `n` log-spaced bands between 30 Hz and 16 kHz, each at least one bin wide.
function logBandEdges(binCount, sampleRate, n) {
  const hzPerBin = sampleRate / 2 / binCount;
  const lo = Math.log(30), hi = Math.log(16000);
  const edges = new Uint16Array(n + 1);
  let prev = 0;
  for (let i = 0; i <= n; i++) {
    let b = Math.round(Math.exp(lo + (hi - lo) * i / n) / hzPerBin);
    b = Math.min(binCount, Math.max(b, i === 0 ? 0 : prev + 1));
    edges[i] = prev = b;
  }
  return edges;
}

// ---- built-in demo loop ---------------------------------------------------------------------
// A small generative lo-fi groove (kick, snare, hats, bass, Rhodes-ish chords) scheduled ahead
// with the Web Audio clock. No audio files, so nothing to license.
class DemoLoop {
  constructor(ctx) {
    this.ctx = ctx;
    this.output = ctx.createGain();
    this.output.gain.value = 0.7;
    this.bpm = 84;
    this.step = 0;
    this.timer = 0;
    this.next = 0;
    // Dm9 – G13 – Cmaj9 – A7(b9): a classic lo-fi turnaround (MIDI notes).
    this.chords = [[50, 53, 57, 60, 64], [43, 53, 57, 59, 64], [48, 52, 55, 59, 62], [45, 49, 55, 58, 61]];
    const len = ctx.sampleRate;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noise = buf;
  }

  start() {
    this.next = this.ctx.currentTime + 0.05;
    const tick = () => {
      const spb = 60 / this.bpm / 4;  // sixteenth notes
      while (this.next < this.ctx.currentTime + 0.2) {
        // Swing: delay every other sixteenth.
        this._schedule(this.step, this.next + (this.step % 2 ? spb * 0.18 : 0));
        this.next += spb;
        this.step = (this.step + 1) % 64;
      }
    };
    tick();
    this.timer = setInterval(tick, 50);
  }

  stop() {
    clearInterval(this.timer);
    try { this.output.disconnect(); } catch {}
  }

  _schedule(step, t) {
    const s = step % 16;
    const bar = Math.floor(step / 16);
    if (s === 0 || s === 10 || (s === 7 && bar % 2)) this._kick(t);
    if (s === 4 || s === 12) this._snare(t);
    if (s % 2 === 0 || Math.random() < 0.3) this._hat(t, s % 4 === 2 ? 0.07 : 0.035);
    const chord = this.chords[bar % 4];
    if (s === 0) this._chord(chord, t, 60 / this.bpm * 3.6);
    if (s === 0 || s === 6 || s === 10) this._bass(chord[0] - 12 + (s === 10 ? 7 : 0), t, 0.35);
  }

  _env(t, a, peak, d) {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
    g.connect(this.output);
    return g;
  }

  _kick(t) {
    const o = this.ctx.createOscillator();
    o.frequency.setValueAtTime(130, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    o.connect(this._env(t, 0.004, 0.9, 0.35));
    o.start(t); o.stop(t + 0.4);
  }

  _noiseHit(t, type, freq, peak, dec) {
    const n = this.ctx.createBufferSource();
    n.buffer = this.noise;
    const f = this.ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq;
    n.connect(f); f.connect(this._env(t, 0.002, peak, dec));
    n.start(t, Math.random() * 0.5); n.stop(t + dec + 0.05);
  }

  _snare(t) { this._noiseHit(t, 'bandpass', 1800, 0.35, 0.18); }
  _hat(t, peak) { this._noiseHit(t, 'highpass', 7500, peak, 0.05); }

  _bass(note, t, dur) {
    const o = this.ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = midiHz(note);
    o.connect(this._env(t, 0.01, 0.5, dur));
    o.start(t); o.stop(t + dur + 0.05);
  }

  _chord(notes, t, dur) {
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 1400;
    lp.connect(this._env(t, 0.03, 0.16, dur));
    for (const n of notes.slice(1)) {
      for (const det of [-6, 6]) {
        const o = this.ctx.createOscillator();
        o.type = 'sine';
        o.frequency.value = midiHz(n + 12);
        o.detune.value = det;
        o.connect(lp);
        o.start(t); o.stop(t + dur + 0.05);
      }
    }
  }
}

function midiHz(n) { return 440 * 2 ** ((n - 69) / 12); }
