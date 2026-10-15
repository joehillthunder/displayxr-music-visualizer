// Spotify: sign in (OAuth 2 authorization code + PKCE, no server), turn this page into a Spotify
// Connect speaker with the Web Playback SDK, and read what's playing.
//
// The SDK's audio is DRM-protected, so the page cannot tap it directly. The visualizer hears it
// the same way it hears any tab: a one-click capture of this tab's audio (AudioEngine.captureThisTab).
// Playback in the browser needs Spotify Premium. Without it (or in a browser without Widevine)
// the Connect speaker will not start; play on any device instead and capture PC audio, and the
// now-playing card still follows along through the Web API.
//
// A Spotify app (client ID) is required: create one at https://developer.spotify.com/dashboard,
// add this page's URL as a Redirect URI, tick "Web API" and "Web Playback SDK", and paste the
// client ID into js/config.js (or the field in the page).

const AUTH = 'https://accounts.spotify.com/authorize';
const TOKEN = 'https://accounts.spotify.com/api/token';
const API = 'https://api.spotify.com/v1';
const SCOPES = [
  'streaming', 'user-read-email', 'user-read-private',
  'user-read-playback-state', 'user-modify-playback-state', 'user-read-currently-playing',
].join(' ');
const KEY = 'dxr-viz.spotify';

export class SpotifyService {
  constructor({ clientId, onTrack, onStatus, onState }) {
    this.clientId = clientId;
    this.onTrack = onTrack;      // ({ title, artist, album, art, service }) | null
    this.onStatus = onStatus;    // (text, kind)
    this.onState = onState;      // () => void, any change worth re-rendering the card for
    this.tokens = load();
    this.player = null;
    this.deviceId = null;
    this.paused = true;
    this.trackKey = '';
    this.pollTimer = 0;
    this.user = null;
  }

  get redirectUri() { return location.origin + location.pathname; }
  get connected() { return !!this.tokens?.access_token; }

  /** Call at boot: finishes a sign-in redirect if this page load is one. */
  async init() {
    const q = new URLSearchParams(location.search);
    const code = q.get('code');
    const state = q.get('state');
    if (code && state && state === sessionStorage.getItem(KEY + '.state')) {
      q.delete('code'); q.delete('state');
      history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q : '') + location.hash);
      await this._exchange(code);
    } else if (q.get('error') && state) {
      q.delete('error'); q.delete('state');
      history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q : ''));
      this.onStatus('Spotify sign-in was cancelled.', 'warn');
    }
    if (this.connected) await this._start();
  }

  async signIn() {
    if (!this.clientId) throw new Error('Add a Spotify client ID first (see the setup note).');
    const verifier = randomString(64);
    const challenge = base64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const state = randomString(16);
    sessionStorage.setItem(KEY + '.verifier', verifier);
    sessionStorage.setItem(KEY + '.state', state);
    const u = new URL(AUTH);
    u.search = new URLSearchParams({
      client_id: this.clientId, response_type: 'code', redirect_uri: this.redirectUri,
      code_challenge_method: 'S256', code_challenge: challenge, scope: SCOPES, state,
    });
    location.assign(u);
  }

  signOut() {
    this.player?.disconnect();
    clearInterval(this.pollTimer);
    this.player = this.deviceId = this.user = null;
    this.tokens = null;
    localStorage.removeItem(KEY);
    this.onTrack(null);
    this.onState();
  }

  async _exchange(code) {
    const body = new URLSearchParams({
      client_id: this.clientId, grant_type: 'authorization_code', code,
      redirect_uri: this.redirectUri, code_verifier: sessionStorage.getItem(KEY + '.verifier') || '',
    });
    const r = await fetch(TOKEN, { method: 'POST', body });
    if (!r.ok) { this.onStatus('Spotify sign-in failed (' + r.status + ').', 'warn'); return; }
    this._saveTokens(await r.json());
  }

  _saveTokens(t) {
    this.tokens = {
      access_token: t.access_token,
      refresh_token: t.refresh_token || this.tokens?.refresh_token,
      expires_at: Date.now() + (t.expires_in - 60) * 1000,
    };
    try { localStorage.setItem(KEY, JSON.stringify(this.tokens)); } catch {}
  }

  async token() {
    if (!this.tokens) return null;
    if (Date.now() < this.tokens.expires_at) return this.tokens.access_token;
    const r = await fetch(TOKEN, {
      method: 'POST',
      body: new URLSearchParams({ client_id: this.clientId, grant_type: 'refresh_token', refresh_token: this.tokens.refresh_token }),
    });
    if (!r.ok) { this.signOut(); this.onStatus('Spotify session expired. Connect again.', 'warn'); return null; }
    this._saveTokens(await r.json());
    return this.tokens.access_token;
  }

  async api(path, { method = 'GET', body } = {}) {
    const t = await this.token();
    if (!t) return null;
    const r = await fetch(API + path, {
      method,
      headers: { Authorization: 'Bearer ' + t, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 204 || r.status === 202) return {};
    if (!r.ok) {
      let msg = r.status + '';
      try { msg = (await r.json()).error?.message || msg; } catch {}
      throw new Error('Spotify: ' + msg);
    }
    return r.json();
  }

  async _start() {
    try { this.user = await this.api('/me'); } catch (e) { this.onStatus(e.message, 'warn'); }
    this.onState();
    this._poll();
    this.pollTimer = setInterval(() => this._poll(), 4000);
    if (this.user?.product === 'premium') this._loadSdk();
  }

  _loadSdk() {
    if (window.Spotify) return this._makePlayer();
    window.onSpotifyWebPlaybackSDKReady = () => this._makePlayer();
    const s = document.createElement('script');
    s.src = 'https://sdk.scdn.co/spotify-player.js';
    document.head.appendChild(s);
  }

  _makePlayer() {
    const player = this.player = new window.Spotify.Player({
      name: '3D Music Visualizer',
      getOAuthToken: (cb) => { this.token().then((t) => t && cb(t)); },
      volume: 0.8,
    });
    player.addListener('ready', ({ device_id }) => { this.deviceId = device_id; this.onState(); });
    player.addListener('not_ready', () => { this.deviceId = null; this.onState(); });
    player.addListener('player_state_changed', (s) => {
      if (!s) return;
      this.paused = s.paused;
      this._track(s.track_window?.current_track);
      this.onState();
    });
    const fail = (what) => ({ message }) => this.onStatus(`Spotify player ${what}: ${message}`, 'warn');
    player.addListener('initialization_error', fail('unavailable in this browser'));
    player.addListener('authentication_error', fail('sign-in error'));
    player.addListener('account_error', fail('needs Spotify Premium'));
    player.connect();
  }

  _track(t) {
    if (!t) return;
    const key = t.uri || t.id;
    if (key === this.trackKey) return;
    this.trackKey = key;
    const images = t.album?.images || [];
    const art = [...images].sort((a, b) => (b.width || 0) - (a.width || 0))[0]?.url;
    this.onTrack({
      service: 'Spotify',
      title: t.name,
      artist: (t.artists || []).map((a) => a.name).join(', '),
      album: t.album?.name,
      art,
    });
  }

  async _poll() {
    try {
      const s = await this.api('/me/player');
      if (!s || !s.item) return;
      this.paused = !s.is_playing;
      this.activeDevice = s.device?.name;
      this._track(s.item);
      this.onState();
    } catch {}
  }

  /** Move playback to this page (it becomes the Connect speaker) and start playing. */
  async playHere() {
    await this.player?.activateElement?.();
    if (!this.deviceId) throw new Error('The Spotify player in this page is not ready yet.');
    await this.api('/me/player', { method: 'PUT', body: { device_ids: [this.deviceId], play: true } });
  }

  async toggle() {
    if (this.player && this.activeDevice === '3D Music Visualizer') return this.player.togglePlay();
    await this.api(this.paused ? '/me/player/play' : '/me/player/pause', { method: 'PUT' });
    setTimeout(() => this._poll(), 400);
  }

  async next() { await this.api('/me/player/next', { method: 'POST' }); setTimeout(() => this._poll(), 600); }
  async prev() { await this.api('/me/player/previous', { method: 'POST' }); setTimeout(() => this._poll(), 600); }

  /** Play a pasted Spotify link (track, album, playlist, artist) on the active device or here. */
  async playLink(link) {
    const m = String(link).match(/(?:open\.spotify\.com\/(?:intl-[a-z]+\/)?|spotify:)(track|album|playlist|artist|episode|show)[/:]([A-Za-z0-9]+)/);
    if (!m) throw new Error('That does not look like a Spotify link.');
    const uri = `spotify:${m[1]}:${m[2]}`;
    const body = m[1] === 'track' || m[1] === 'episode' ? { uris: [uri] } : { context_uri: uri };
    const q = this.deviceId && (!this.activeDevice || this.activeDevice === '3D Music Visualizer') ? '?device_id=' + this.deviceId : '';
    await this.api('/me/player/play' + q, { method: 'PUT', body });
    setTimeout(() => this._poll(), 800);
  }
}

function load() { try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; } }

function randomString(n) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const v = crypto.getRandomValues(new Uint8Array(n));
  return [...v].map((x) => chars[x % chars.length]).join('');
}

function base64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}
