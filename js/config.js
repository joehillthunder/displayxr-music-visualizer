// Service credentials. Both are meant to be public: a Spotify client ID is not a secret under
// PKCE, and a MusicKit developer token is sent to every visitor's browser by design (keep its
// expiry reasonable and restrict it to this site's origin when you generate it).
//
// Either can also be pasted into the page, which keeps it in that browser only.

// https://developer.spotify.com/dashboard → Create app → Redirect URI = this page's URL
// (e.g. https://joehillthunder.github.io/displayxr-music-visualizer/), APIs: Web API + Web Playback SDK.
export const SPOTIFY_CLIENT_ID = '';

// A MusicKit developer token (JWT) from an Apple Developer Program account.
export const APPLE_MUSIC_DEVELOPER_TOKEN = '';
