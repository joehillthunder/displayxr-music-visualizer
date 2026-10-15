# CLAUDE.md

Audio-reactive music visualizer with real depth on Leia glasses-free 3D displays, built on the
DisplayXR inline-3D web SDK. It's a static site with no build step, served by GitHub Pages from
the `main` branch root (`.nojekyll`). It's live at https://joehillthunder.github.io/displayxr-music-visualizer/.

## Layout

- `index.html`: the page, all CSS, and the import map. three 0.161.0 and `@displayxr/inline3d`
  1.45.1 are pinned on jsDelivr. Keep versions pinned.
- `js/main.js`: app shell. One renderer on one persistent `<canvas>`, the inline-3D session
  (`createInline3D` + `addScene`), the per-eye render loop and post-processing, style, layout and
  drift management, and all UI wiring.
- `js/audio.js`: `AudioEngine` (capture, FFT analysis, onsets, BPM) and the built-in demo synth.
- `js/interact.js`: drag-to-turn, zoom, tap-to-pop, swipe-to-swat and the pop effects.
- `js/palette.js`: album-art palette extraction. `js/config.js`: optional Spotify client ID.
- `js/services/`: `spotify.js` (PKCE sign-in, Web Playback SDK, Web API) and `youtube.js` (IFrame
  API). Apple Music was removed on purpose; don't re-add it unless asked.
- `js/styles/*.js`: one file per style. `common.js` holds the shared contract and helpers.
  `STYLES` in `main.js` sets the order, and keys 1–9, 0 follow it.

## The style contract (`js/styles/common.js`)

Each style is a class with `static meta {id, name, blurb}`, `bloom`, `palette` (5 hex colours),
`variations` (3 layout names) and `drift {yaw, pitch}`. It also has `constructor(THREE)`, which
builds `this.group`, plus `update(audio, dt)`, `setPalette(rgb[]|null)`, `setVariation(i)` and
`dispose()`. Optional members: `beforeRender(vpH)` (point sprites), `targets` (Flyers pools you
can pop), `popped()`, `tap(ray, fx)` (return true if handled), `hover(ray, dt)` and `cursorTargets`.

To add a style, write the file, add it to `STYLES` in `main.js`, then update the README tables
and the `?style=` list.

Rules every style follows:
- **Units are metres** on a 0.12 m virtual display (`VIRTUAL_DISPLAY_HEIGHT`). z = 0 is the
  glass and +z comes toward the viewer.
- **Pop-out stops at `POP_MAX` (0.05 m)** and must fade near the window edges, where the frame
  would cut it off. Use `Flyers` (it does both) or `EDGE_FADE_GLSL` for points. Big objects in
  front of the glass must stay away from the edges.
- **Shader colours**: author in sRGB, wrap in `toLinear()`, and end every fragment shader with
  `#include <colorspace_fragment>`. Values above 1 glow under bloom. `#include` must be on its own
  line.
- Use `Palette` for colours, so album-art matching works, and `Blend` for layout changes, so
  variations ease in rather than snap.
- Move content, never the eyes: on a display rig the runtime owns the viewpoint. Drift, drag and
  layouts all transform groups.

## DisplayXR rules (don't break these)

From the SDK's woven-canvas rules: keep one inline-3D session and one canvas for the life of the
page, and never remount it. Put no CSS `filter`, `opacity`, `border-radius`, `box-shadow` or
`backdrop-filter` on the canvas or anything over or around it; overlays use a plain `rgba` tint.
Cover the canvas until `handle.firstWoven`, and remove the cover with a hard cut. Validate views
before clearing, and replay the last good frame. Clamp the side-by-side buffer to the GPU limits
and the panel width. Point-sprite sizes use the height of the buffer they render into
(`beforeRender(vp.height * scale)`).

## Gotchas found the hard way

- **Keep the clear colour pure black.** With the EffectComposer, a non-black clear turns grey:
  RenderPass reuses the sRGB clear value left by the last on-screen draw, and OutputPass converts
  it again.
- **The 8K panel (7680×4320)** gives each eye about 3744×2106. Post-processing is capped by
  `maxEyeW` (Ultra 2560, High 1920); uncapped it ran at about 30 fps.
- **Headless Chrome renders only a few frames** under `--virtual-time-budget`. Use `?warm=N` (for
  example 120–150) or effects that build up, like fireworks and flocks, look empty.
- **The `gh` token has no `workflow` scope**, so pushing `.github/workflows/*` is rejected. Pages is
  served from the `main` branch root instead. After a push the CDN can serve stale files for about
  10 minutes; check with `?nc=$RANDOM`.
- Spotify's and YouTube's audio can't be read directly (DRM or a cross-origin frame). The page
  captures its own tab instead (`captureThisTab`, `preferCurrentTab`).

## Testing

There's no node or python on the demo PC. Serve the folder with any static server; a PowerShell
`HttpListener` script works. Then:

- **Headless smoke test:** `chrome --headless=new --use-angle=d3d11
  --autoplay-policy=no-user-gesture-required --enable-logging=stderr --v=0 --screenshot=out.png
  "http://localhost:PORT/?style=ID&var=0&novary&demo&warm=120"`, then grep `CONSOLE` for errors.
  Use a fresh `--user-data-dir`, or cached modules hide your edits.
- **Interaction:** headless can't click, so drive a test page that imports a style, calls
  `update`, `hover` and `tap`, and pops a target through `pool.hit` and `pool.pop`.
- **On the 3D panel:** `"C:\Program Files\DisplayXR\Browser\chrome.exe" --user-data-dir=<scratch>
  --enable-logging --v=0 <url>`. The page logs `[visualizer] firstWoven woven=… confirmed=…`,
  then `frames=… monoFrames=…` every 5 s, to `chrome_debug.log` in that profile. Runtime logs are
  in `%LOCALAPPDATA%\DisplayXR\`. Close only the browser processes you started.
- Useful URL parameters: `?style=`, `?var=0|1|2`, `?novary`, `?demo`, `?warm=N`,
  `?quality=ultra|high|fast`, `?glow=`, `?tab=spotify|youtube|more`.

Report only what a log or tool actually printed. Never write expected output into a status update.

## Conventions

- Match the existing code: ES modules, 2-space indent, explanatory block comments at the top of
  each file and on anything non-obvious, and no dependencies beyond the pinned CDN imports.
- The README documents every style, layout, interaction, key and URL parameter. Keep it in sync.
- Commit to `main` (it deploys). End commit messages with the `Co-Authored-By` line the session
  provides.
