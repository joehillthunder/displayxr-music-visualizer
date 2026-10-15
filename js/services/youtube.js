// YouTube (and YouTube Music links): an embedded player in the page, driven by the IFrame API.
// No sign-in or API key. The player is cross-origin, so the visualizer hears it through a
// one-click capture of this tab's audio, like the other services.

export class YouTubeService {
  constructor({ host, onTrack, onStatus, onState }) {
    this.host = host;            // element the player iframe replaces
    this.onTrack = onTrack;
    this.onStatus = onStatus;
    this.onState = onState;
    this.player = null;
    this.ready = null;
    this.playing = false;
    this.videoId = '';
  }

  _load() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve) => {
      const make = () => {
        this.player = new window.YT.Player(this.host, {
          width: 356, height: 200,
          playerVars: { playsinline: 1, rel: 0, modestbranding: 1, origin: location.origin },
          events: {
            onReady: () => resolve(this.player),
            onStateChange: (e) => this._stateChange(e.data),
            onError: (e) => this.onStatus(`YouTube can't play that here (error ${e.data}). Some videos block embedding.`, 'warn'),
          },
        });
      };
      if (window.YT?.Player) return make();
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => { prev?.(); make(); };
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      document.head.appendChild(s);
    });
    return this.ready;
  }

  _stateChange(state) {
    this.playing = state === 1;
    if (state === 1 || state === -1 || state === 5) {
      const d = this.player.getVideoData?.() || {};
      // Keyed on id + title: a cued video can report an empty title until it starts playing.
      if (d.video_id && d.video_id + d.title !== this.videoId) {
        this.videoId = d.video_id + d.title;
        this.onTrack({
          service: 'YouTube',
          title: d.title || 'YouTube video',
          artist: d.author || '',
          art: `https://i.ytimg.com/vi/${d.video_id}/hqdefault.jpg`,
        });
      }
    }
    this.onState();
  }

  /** Cue a pasted link: a video, a playlist, youtu.be, Shorts or music.youtube.com. */
  async load(link, autoplay) {
    const p = parseLink(link);
    if (!p) throw new Error('That does not look like a YouTube link.');
    const player = await this._load();
    if (p.list) {
      const opts = { listType: 'playlist', list: p.list, index: 0 };
      autoplay ? player.loadPlaylist(opts) : player.cuePlaylist(opts);
    } else {
      autoplay ? player.loadVideoById(p.video) : player.cueVideoById(p.video);
    }
    this.onState();
  }

  async play() { (await this._load()).playVideo(); }
  toggle() { if (!this.player) return; this.playing ? this.player.pauseVideo() : this.player.playVideo(); }
  next() { this.player?.nextVideo(); }
  prev() { this.player?.previousVideo(); }
}

function parseLink(s) {
  s = String(s).trim();
  if (/^[\w-]{11}$/.test(s)) return { video: s };
  let u;
  try { u = new URL(s); } catch { return null; }
  if (!/(^|\.)youtube\.com$|(^|\.)youtu\.be$|(^|\.)youtube-nocookie\.com$/.test(u.hostname)) return null;
  const list = u.searchParams.get('list');
  let video = u.searchParams.get('v');
  if (!video && u.hostname.endsWith('youtu.be')) video = u.pathname.slice(1);
  if (!video) video = u.pathname.match(/\/(?:shorts|embed|live)\/([\w-]{11})/)?.[1];
  if (list && !video) return { list };
  if (video) return list ? { list, video } : { video };
  return null;
}
