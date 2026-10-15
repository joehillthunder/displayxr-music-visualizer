// Service credentials. A Spotify client ID is meant to be public: sign-in uses PKCE, so there is
// no client secret. It can also be pasted into the page, which keeps it in that browser only.

// https://developer.spotify.com/dashboard → Create app → Redirect URI = this page's URL
// (e.g. https://joehillthunder.github.io/displayxr-music-visualizer/), APIs: Web API + Web Playback SDK.
export const SPOTIFY_CLIENT_ID = '';
