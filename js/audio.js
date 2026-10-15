// Audio input and analysis.
//
// One AudioContext for the life of the page. A source (this tab's audio while a Spotify or
// YouTube player plays here, another tab or the whole PC, a microphone or line-in, a
// local file, or the built-in demo loop) feeds a mono analyser plus a left/right pair. Each
// animation frame, update() turns them into the features every style reads:
//
//   bands[128]          log-spaced spectrum 25 Hz – 18 kHz, 0..1, attack/release smoothed
//   bandsL/bandsR[32]   the same per stereo channel (coarser), for left/right placement
//   wave[256]           time-domain waveform, -1..1
//   bass, mid, treble, level   band energies, 0..1
//   pan                 -1 (left-heavy) .. +1 (right-heavy)
//   beat                1 on a detected onset, decaying to 0 over ~0.25 s
//   beatCount           onsets so far
//   bpm, beatPhase      tempo estimate and 0..1 position within the current beat
//   centroid            spectral brightness, 0..1
//   time                seconds of music-driven time (runs faster when the music is louder)
//
// With no source the features idle at a low, slowly breathing level so every style still moves.

export const BAND_COUNT = 128;
export const STEREO_BANDS = 32;
export const WAVE_POINTS = 256;

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.source = null;
    this.stream = null;
    this.mediaEl = null;
    this.demo = null;
    this.gain = 1;
    this.sourceLabel = 'none';
    this.sourceKind = null;      // 'tab' | 'system' | 'input' | 'file' | 'demo'
    this.onSourceEnded = null;

    this.bands = new Float32Array(BAND_COUNT);
    this.bandsL = new Float32Array(STEREO_BANDS);
    this.bandsR = new Float32Array(STEREO_BANDS);
    this.wave = new Float32Array(WAVE_POINTS);
    this.bass = 0; this.mid = 0; this.treble = 0; this.level = 0; this.pan = 0;
    this.beat = 0; this.beatCount = 0; this.centroid = 0.4;
    this.bpm = 0; this.beatPhase = 0;
    this.time = 0;

    this._prev = new Float32Array(BAND_COUNT);
    this._flux = new Float32Array(64);
    this._fluxI = 0;
    this._sinceBeat = 1;
    this._onsets = [];
    this._autoGain = 1;
    this._clock = 0;
  }

  get active() { return !!this.source; }

  _ensureContext() {
    if (this.ctx) return;
    const ctx = this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.input = ctx.createGain();
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 8192;              // ~5.9 Hz bins at 48 kHz: a clean low end
    this.analyser.smoothingTimeConstant = 0.35;
    this.analyser.minDecibels = -95;
    this.analyser.maxDecibels = -12;
    this.input.connect(this.analyser);
    const split = ctx.createChannelSplitter(2);
    this.input.connect(split);
    this.anL = ctx.createAnalyser(); this.anR = ctx.createAnalyser();
    for (const a of [this.anL, this.anR]) {
      a.fftSize = 2048; a.smoothingTimeConstant = 0.5; a.minDecibels = -95; a.maxDecibels = -12;
    }
    split.connect(this.anL, 0); split.connect(this.anR, 1);
    this._freq = new Uint8Array(this.analyser.frequencyBinCount);
    this._freqL = new Uint8Array(this.anL.frequencyBinCount);
    this._freqR = new Uint8Array(this.anR.frequencyBinCount);
    this._time = new Float32Array(2048);
    this._edges = logBandEdges(this.analyser.frequencyBinCount, ctx.sampleRate, BAND_COUNT);
    this._edgesS = logBandEdges(this.anL.frequencyBinCount, ctx.sampleRate, STEREO_BANDS);
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
    this.sourceKind = null;
  }

  _useStream(stream, label, kind) {
    const track = stream.getAudioTracks()[0];
    this.stream = stream;
    this.source = this.ctx.createMediaStreamSource(new MediaStream([track]));
    // Captured audio goes to the analysers only, never the speakers: it is already playing.
    this.source.connect(this.input);
    this.sourceLabel = label;
    this.sourceKind = kind;
    track.addEventListener('ended', () => {
      if (this.stream === stream) { this.stop(); this.onSourceEnded?.(); }
    });
  }

  static audioConstraints() {
    return {
      echoCancellation: false, noiseSuppression: false, autoGainControl: false,
      channelCount: 2, sampleRate: 48000,
      suppressLocalAudioPlayback: false,     // keep hearing the tab while it is captured
    };
  }

  /**
   * This tab's own audio: what the in-page Spotify or YouTube player plays. Chrome
   * offers "this tab" as a one-click choice. Must be called from a click.
   */
  async captureThisTab() {
    await this._resume();
    if (this.sourceKind === 'tab' && this.stream?.active) return;
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 1, width: 320, height: 180 },
      audio: AudioEngine.audioConstraints(),
      preferCurrentTab: true,
      selfBrowserSurface: 'include',
      systemAudio: 'exclude',
      surfaceSwitching: 'exclude',
      monitorTypeSurfaces: 'exclude',
    });
    if (!stream.getAudioTracks().length) {
      for (const t of stream.getTracks()) t.stop();
      throw new Error('No audio was shared. Choose "This tab" and keep "Share tab audio" on.');
    }
    this.stop();
    this._useStream(stream, 'This tab', 'tab');
  }

  /** Audio from another tab, an app, or the whole PC. Must be called from a click. */
  async captureSystem() {
    await this._resume();
    // Chromium needs a video track to offer audio. "Entire screen" + "Share system audio"
    // captures everything the PC plays; a tab share captures that tab only.
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 1, width: 320, height: 180 },
      audio: AudioEngine.audioConstraints(),
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
    const surface = stream.getVideoTracks()[0]?.getSettings?.().displaySurface;
    this._useStream(stream, surface === 'browser' ? 'Shared tab' : 'PC audio', 'system');
  }

  /** A microphone, a USB interface, a "Stereo Mix" device, or line-in from a phone or streamer. */
  async captureInput(deviceId) {
    await this._resume();
    const c = AudioEngine.audioConstraints();
    delete c.suppressLocalAudioPlayback;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { ...c, deviceId: deviceId ? { exact: deviceId } : undefined },
    });
    this.stop();
    this._useStream(stream, stream.getAudioTracks()[0].label || 'Audio input', 'input');
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
    this.source.connect(this.input);
    this.source.connect(this.ctx.destination);
    this.sourceLabel = file.name;
    this.sourceKind = 'file';
    await el.play();
  }

  /** A synthesized lo-fi loop, so the visuals can be tried without any music source. */
  async playDemo() {
    await this._resume();
    this.stop();
    this.demo = new DemoLoop(this.ctx);
    this.source = this.demo.output;
    this.source.connect(this.input);
    this.source.connect(this.ctx.destination);
    this.demo.start();
    this.sourceLabel = 'Demo loop';
    this.sourceKind = 'demo';
  }

  /** Call once per animation frame. */
  update(dt) {
    dt = Math.min(dt, 0.1);
    this._clock += dt;
    const bands = this.bands;
    let bass = 0, mid = 0, treble = 0, flux = 0;

    if (this.source) {
      this.analyser.getByteFrequencyData(this._freq);
      const f = this._freq, e = this._edges;
      const g = this.gain * this._autoGain;
      let num = 0, den = 0, peak = 0;
      for (let i = 0; i < BAND_COUNT; i++) {
        // Wide bands take the RMS of their bins (stable), narrow ones the peak (detailed).
        let s = 0, sq = 0, n = 0;
        for (let k = e[i]; k < e[i + 1]; k++) { s = Math.max(s, f[k]); sq += f[k] * f[k]; n++; }
        const lvl = n > 3 ? Math.sqrt(sq / n) * 0.6 + s * 0.4 : s;
        // Tilt: high bands carry less energy in music; lift them so the spectrum reads level.
        const v = Math.min(1, (lvl / 255) * (0.82 + 0.55 * i / BAND_COUNT) * g);
        flux += Math.max(0, v - this._prev[i]) * (i < BAND_COUNT * 0.25 ? 1.6 : 1);
        this._prev[i] = v;
        bands[i] += (v - bands[i]) * (v > bands[i] ? 0.7 : 0.16);
        num += v * i; den += v; peak = Math.max(peak, v);
      }
      const q = BAND_COUNT / 64;
      bass = avg(bands, 0, 8 * q); mid = avg(bands, 8 * q, 36 * q); treble = avg(bands, 36 * q, BAND_COUNT);
      this.centroid += ((den > 0 ? num / den / BAND_COUNT : 0.4) - this.centroid) * 0.05;
      // Slow automatic gain so quiet captures and loud files both fill the range.
      const target = peak > 0.02 ? clamp(0.85 / peak, 0.6, 3.5) : this._autoGain;
      this._autoGain += (target - this._autoGain) * dt * 0.25;

      this.anL.getByteFrequencyData(this._freqL);
      this.anR.getByteFrequencyData(this._freqR);
      let sl = 0, sr = 0;
      for (let i = 0; i < STEREO_BANDS; i++) {
        let l = 0, r = 0;
        for (let k = this._edgesS[i]; k < this._edgesS[i + 1]; k++) { l = Math.max(l, this._freqL[k]); r = Math.max(r, this._freqR[k]); }
        const tilt = (0.82 + 0.55 * i / STEREO_BANDS) * g / 255;
        l = Math.min(1, l * tilt); r = Math.min(1, r * tilt);
        this.bandsL[i] += (l - this.bandsL[i]) * (l > this.bandsL[i] ? 0.7 : 0.16);
        this.bandsR[i] += (r - this.bandsR[i]) * (r > this.bandsR[i] ? 0.7 : 0.16);
        sl += l; sr += r;
      }
      this.pan += ((sl + sr > 0.05 ? (sr - sl) / (sr + sl) : 0) - this.pan) * 0.08;

      this.analyser.getFloatTimeDomainData(this._time);
      const step = this._time.length / WAVE_POINTS;
      for (let i = 0; i < WAVE_POINTS; i++) {
        const v = clamp(this._time[Math.floor(i * step)] * 2.5 * this.gain, -1, 1);
        this.wave[i] += (v - this.wave[i]) * 0.6;
      }
    } else {
      // Idle: a gentle breathing so the scene is alive before any source is chosen.
      const t = performance.now() / 1000;
      for (let i = 0; i < BAND_COUNT; i++) {
        const v = 0.12 + 0.08 * Math.sin(t * 0.9 + i * 0.18) * Math.sin(t * 0.37 + i * 0.055);
        bands[i] += (v * (1 - i / BAND_COUNT * 0.5) - bands[i]) * 0.1;
      }
      for (let i = 0; i < STEREO_BANDS; i++) {
        this.bandsL[i] = bands[i * 4] * (1 + 0.2 * Math.sin(t * 0.5));
        this.bandsR[i] = bands[i * 4] * (1 - 0.2 * Math.sin(t * 0.5));
      }
      for (let i = 0; i < WAVE_POINTS; i++) this.wave[i] = 0.08 * Math.sin(i * 0.15 + t * 3) * Math.sin(t * 0.7);
      bass = 0.15 + 0.1 * Math.sin(t * 1.6) ** 8; mid = 0.12; treble = 0.08;
      this.pan = Math.sin(t * 0.5) * 0.2;
    }

    const k = 1 - Math.exp(-dt * 14);
    this.bass += (bass - this.bass) * k;
    this.mid += (mid - this.mid) * k;
    this.treble += (treble - this.treble) * k;
    this.level = this.bass * 0.5 + this.mid * 0.35 + this.treble * 0.15;

    // Onsets: spectral flux (weighted to the low end) clearly above its recent average.
    const h = this._flux;
    let mean = 0; for (let i = 0; i < h.length; i++) mean += h[i]; mean /= h.length;
    let varc = 0; for (let i = 0; i < h.length; i++) varc += (h[i] - mean) ** 2; varc /= h.length;
    h[this._fluxI = (this._fluxI + 1) % h.length] = flux;
    this._sinceBeat += dt;
    const threshold = mean + Math.max(0.25, 1.6 * Math.sqrt(varc));
    if (this.source && flux > threshold && this.bass > 0.12 && this._sinceBeat > 0.22) {
      this.beat = 1; this.beatCount++; this._sinceBeat = 0;
      this._onsets.push(this._clock);
      if (this._onsets.length > 24) this._onsets.shift();
      this._estimateTempo();
    } else if (!this.source && this._sinceBeat > 60 / 84) {
      this.beat = 1; this.beatCount++; this._sinceBeat = 0;   // idle pulse
    } else {
      this.beat *= Math.exp(-dt * 9);
    }
    if (this.bpm > 0) {
      const period = 60 / this.bpm;
      this.beatPhase = ((this._clock - (this._onsets.at(-1) ?? 0)) / period) % 1;
    } else {
      this.beatPhase = Math.min(1, this._sinceBeat / 0.6);
    }

    this.time += dt * (0.4 + this.level * 1.6);
  }

  // Tempo from the intervals between recent onsets: each interval votes for every tempo that
  // would fit 1–4 beats into it (70–180 BPM), so skipped beats and off-beats still agree.
  _estimateTempo() {
    const o = this._onsets;
    if (o.length < 8) return;
    const votes = new Float32Array(111);
    for (let i = 1; i < o.length; i++) {
      for (let j = Math.max(0, i - 4); j < i; j++) {
        const dtv = o[i] - o[j];
        for (let m = 1; m <= 4; m++) {
          const b = Math.round(60 * m / dtv) - 70;
          if (b >= 0 && b < votes.length) votes[b] += 1 / m;
        }
      }
    }
    let best = 0;
    for (let b = 1; b < votes.length; b++) if (votes[b] > votes[best]) best = b;
    if (votes[best] >= 3) this.bpm = this.bpm ? this.bpm * 0.8 + (best + 70) * 0.2 : best + 70;
  }
}

function avg(a, from, to) { let s = 0; for (let i = from; i < to; i++) s += a[i]; return s / (to - from); }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// FFT bin edges for `n` log-spaced bands between 25 Hz and 18 kHz, each at least one bin wide.
function logBandEdges(binCount, sampleRate, n) {
  const hzPerBin = sampleRate / 2 / binCount;
  const lo = Math.log(25), hi = Math.log(18000);
  const edges = new Uint16Array(n + 1);
  let prev = 0;
  for (let i = 0; i <= n; i++) {
    let b = Math.round(Math.exp(lo + (hi - lo) * i / n) / hzPerBin);
    b = Math.min(binCount, Math.max(b, i === 0 ? 1 : prev + 1));   // skip bin 0 (DC)
    edges[i] = prev = b;
  }
  return edges;
}

// ---- built-in demo loop ---------------------------------------------------------------------
// A small generative lo-fi groove (kick, snare, hats, bass, Rhodes-ish chords) scheduled ahead
// with the Web Audio clock, with the hats and chords panned for stereo. No audio files.
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
    if (s % 2 === 0 || Math.random() < 0.3) this._hat(t, s % 4 === 2 ? 0.07 : 0.035, s % 4 === 2 ? 0.6 : -0.5);
    const chord = this.chords[bar % 4];
    if (s === 0) this._chord(chord, t, 60 / this.bpm * 3.6);
    if (s === 0 || s === 6 || s === 10) this._bass(chord[0] - 12 + (s === 10 ? 7 : 0), t, 0.35);
  }

  _env(t, a, peak, d, pan = 0) {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
    if (pan) {
      const p = this.ctx.createStereoPanner();
      p.pan.value = pan;
      g.connect(p); p.connect(this.output);
    } else {
      g.connect(this.output);
    }
    return g;
  }

  _kick(t) {
    const o = this.ctx.createOscillator();
    o.frequency.setValueAtTime(130, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    o.connect(this._env(t, 0.004, 0.9, 0.35));
    o.start(t); o.stop(t + 0.4);
  }

  _noiseHit(t, type, freq, peak, dec, pan) {
    const n = this.ctx.createBufferSource();
    n.buffer = this.noise;
    const f = this.ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq;
    n.connect(f); f.connect(this._env(t, 0.002, peak, dec, pan));
    n.start(t, Math.random() * 0.5); n.stop(t + dec + 0.05);
  }

  _snare(t) { this._noiseHit(t, 'bandpass', 1800, 0.35, 0.18, 0.1); }
  _hat(t, peak, pan) { this._noiseHit(t, 'highpass', 7500, peak, 0.05, pan); }

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
    lp.connect(this._env(t, 0.03, 0.16, dur, Math.random() * 0.8 - 0.4));
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
