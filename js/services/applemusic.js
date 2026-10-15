// Apple Music: MusicKit JS v3 plays in the page; subscribers sign in for full tracks (others get
// 30-second previews). Like Spotify, the audio is DRM-protected, so the visualizer hears it
// through a one-click capture of this tab's audio.
//
// MusicKit needs a developer token: a JWT signed with a MusicKit key from an Apple Developer
// Program account (https://developer.apple.com/documentation/applemusicapi/generating-developer-tokens).
// Put it in js/config.js or paste it into the field in the page. Without one, open the Apple
// Music web player in another tab and capture that tab instead.

const SDK = 'https://js-cdn.music.apple.com/musickit/v3/musickit.js';

export class AppleMusicService {
  constructor({ developerToken, onTrack, onStatus, onState }) {
    this.developerToken = developerToken;
    this.onTrack = onTrack;
    this.onStatus = onStatus;
    this.onState = onState;
    this.music = null;
    this.ready = null;
    this.itemId = '';
  }

  get configured() { return !!this.developerToken; }
  get authorized() { return !!this.music?.isAuthorized; }
  get playing() { return this.music?.playbackState === 2; }   // MusicKit.PlaybackStates.playing

  _load() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const go = async () => {
        try {
          await window.MusicKit.configure({
            developerToken: this.developerToken,
            app: { name: '3D Music Visualizer', build: '1.0.0' },
          });
          const m = this.music = window.MusicKit.getInstance();
          m.addEventListener('nowPlayingItemDidChange', () => this._item());
          m.addEventListener('playbackStateDidChange', () => this.onState());
          m.addEventListener('authorizationStatusDidChange', () => this.onState());
          resolve(m);
        } catch (e) { reject(e); }
      };
      if (window.MusicKit) return go();
      document.addEventListener('musickitloaded', go, { once: true });
      const s = document.createElement('script');
      s.src = SDK;
      s.dataset.webComponents = '';
      s.onerror = () => reject(new Error('MusicKit could not be loaded.'));
      document.head.appendChild(s);
    });
    return this.ready;
  }

  async init() {
    if (!this.configured) return;
    try { await this._load(); this.onState(); } catch (e) { this.onStatus('Apple Music: ' + e.message, 'warn'); }
  }

  async signIn() { await (await this._load()).authorize(); this.onState(); }
  async signOut() { await this.music?.unauthorize(); this.onState(); }

  _item() {
    const it = this.music?.nowPlayingItem;
    if (!it || it.id === this.itemId) return;
    this.itemId = it.id;
    const a = it.attributes || {};
    this.onTrack({
      service: 'Apple Music',
      title: a.name || it.title,
      artist: a.artistName || it.artistName,
      album: a.albumName || it.albumName,
      art: a.artwork?.url ? a.artwork.url.replace('{w}', '600').replace('{h}', '600') : undefined,
    });
    this.onState();
  }

  /** Queue and play a pasted music.apple.com link (song, album, playlist or station). */
  async playLink(link) {
    const m = await this._load();
    const u = new URL(String(link).trim());
    if (!/music\.apple\.com$/.test(u.hostname)) throw new Error('That does not look like an Apple Music link.');
    const parts = u.pathname.split('/').filter(Boolean);
    const kind = parts.find((p) => ['album', 'playlist', 'song', 'station', 'music-video'].includes(p));
    const id = parts.at(-1);
    const song = u.searchParams.get('i');
    let opts;
    if (song) opts = { song };
    else if (kind === 'album') opts = { album: id };
    else if (kind === 'playlist') opts = { playlist: id };
    else if (kind === 'song') opts = { song: id };
    else if (kind === 'station') opts = { station: id };
    else throw new Error('Paste a link to a song, album, playlist or station.');
    await m.setQueue({ ...opts, startPlaying: true });
  }

  toggle() { if (!this.music) return; this.playing ? this.music.pause() : this.music.play(); }
  next() { this.music?.skipToNextItem(); }
  prev() { this.music?.skipToPreviousItem(); }
}
