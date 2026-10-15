# 3D Music Visualizer

A music visualizer with real depth on glasses-free 3D displays. It reacts to whatever you're
listening to: Spotify, Apple Music, YouTube, Tidal, a phone streaming over Bluetooth, or a mic in
the room. It's built on [DisplayXR](https://displayxr.org), so on a Leia SR display in the DisplayXR
Browser the visuals come out of the screen and you can look around them. In any other browser it
runs in 2D.

**Open it:** https://joehillthunder.github.io/displayxr-music-visualizer/

| Lo-Fi Room | Impressionist Garden | Neon Horizon |
|---|---|---|
| ![Lo-Fi Room](assets/lofi.png) | ![Impressionist Garden](assets/impressionist.png) | ![Neon Horizon](assets/synthwave.png) |

| Cosmic Nebula | Liquid Orb |
|---|---|
| ![Cosmic Nebula](assets/nebula.png) | ![Liquid Orb](assets/orb.png) |

## Styles

| # | Style | What it looks like | How it uses depth |
|---|---|---|---|
| 1 | **Lo-Fi Room** | Chunky voxel spectrogram in a muted sunset palette, with a low-poly moon and pixel dust | The newest spectrum row sits at the glass and older rows scroll back into the screen |
| 2 | **Impressionist Garden** | Thousands of painted brushstrokes that follow a flow field, swell with the bass and catch gold light on the highs | Strokes sit in layers, from hazy water far behind the glass to a few dabs in front of it. Each beat sends a ripple out toward you |
| 3 | **Neon Horizon** | Synthwave grid landscape under a striped sun | Mountains shaped by the spectrum roll out of the screen toward you |
| 4 | **Cosmic Nebula** | A spiral galaxy: bass in the core, highs in the outer arms | The tilted disc hangs behind the glass. Beats send a shockwave that lifts stars toward you, and near-field dust drifts past |
| 5 | **Liquid Orb** | Iridescent liquid-metal sphere inside a ring of spectrum bars | The orb sits in the glass and the front of the ring comes out of the screen |

Other styles that would work well in 3D: a kaleidoscope tunnel, a particle waveform ribbon, a
watercolour bloom, and a city skyline equalizer.

## Getting music in

The page analyzes audio on the PC it's running on. It never records or uploads anything.

- **Capture PC audio** (the main way): click it, choose **Entire screen**, and turn on
  **Share system audio**. Anything the PC plays then drives the visuals, whether that's the
  Spotify app, a YouTube tab or a Bluetooth/AirPlay receiver app. To follow a single browser tab,
  share that tab and turn on **Share tab audio**.
- **Phone or another device:** stream to the PC over Bluetooth, AirPlay or Spotify Connect, then
  use Capture PC audio. Or cable it into the line-in, pick the input and click **Use input**.
- **Microphone:** pick it and click **Use input**. Good for a live set.
- **Open file / drag and drop:** plays a local audio file.
- **Demo loop:** a built-in synthesized lo-fi beat, for when no music is handy.

## Controls

`1`–`5` pick a style · `←` `→` previous/next · `A` auto-cycle (changes style on a beat every
~40 s) · `F` full view · `Esc` exit.

**Sensitivity** scales the input level (there's also slow auto-gain). **Depth** scales how far the
scene reaches in and out of the screen.

URL parameters: `?style=lofi|impressionist|synthwave|nebula|orb`, `?auto`.

## Hardware

- **For 3D:** a Leia SR glasses-free 3D display on Windows, running the
  [DisplayXR Browser](https://displayxr.org/browser).
- **Anywhere else:** any modern desktop browser shows it in 2D, with slight mouse parallax. System
  audio capture needs a Chromium browser (Chrome or Edge) on Windows or ChromeOS. On macOS,
  share a tab or use an input.

## How it works

- Plain ES modules with no build step: [three.js](https://threejs.org) 0.161 and
  [`@displayxr/inline3d`](https://www.npmjs.com/package/@displayxr/inline3d) 1.45.1, pinned from
  jsDelivr through an import map.
- `js/audio.js`: Web Audio capture and analysis. It reduces a 4096-point FFT to 64 log-spaced
  bands, bass/mid/treble energy, spectral centroid and an adaptive beat detector. It also holds
  the demo synth.
- `js/main.js`: one persistent woven canvas (`createInline3D` + `addScene`). Each frame the scene
  renders once per eye from the session's views, at a 0.12 m virtual display height. It follows
  the DisplayXR [woven-canvas rules](https://github.com/DisplayXR/displayxr-web/blob/main/docs/woven-canvas-rules.md):
  it never remounts the canvas, covers it until `firstWoven`, validates views before clearing and
  replays the last good frame, clamps the SBS buffer size, uses `rectCover` for full view, and
  puts no CSS effects on the canvas. Styles change inside the canvas with a fade through black.
- `js/styles/*.js`: one file per style, all with the same small interface (see
  `js/styles/common.js`). Each is authored in metres around the z = 0 glass plane, where +z is
  toward the viewer. Adding a style means adding a file and listing it in `STYLES` in `main.js`.

Run it locally by serving the folder with any static server (for example
`npx serve .`) and opening it in a browser.

## License

[Apache 2.0](LICENSE). The demo loop is synthesized in the browser, so no audio assets ship with
the app.
