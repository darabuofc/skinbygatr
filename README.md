# Panel Mapper

Projection mapping with audio-reactive visuals for live shows. Map one projector onto
several panels, drive the visuals from the music, and run the whole night offline.

Built with Next.js (static export), WebGL2 and Web Audio. Deploys to Vercel as an
installable web app (PWA).

## Features

- **Perform / Setup tabs.** A bar pinned to the top of the controls always shows Blackout (B), Show mode (E), the kick light and
  Master brightness. **Perform** holds cues, the beat (audio start/stop, meters, BPM, tap) and scenes, with larger buttons and a scene
  grid. **Setup** holds the pre-show check, projectors, panels, sound input, videos, images, MIDI, layout and keyboard help.
  The last tab you used is remembered in this browser.
- **Collapsible sections.** Click any section heading to fold it; open/closed state is remembered per section in this browser.
  Long explanations sit behind a small **? How this works** link instead of taking up space. Live status and warnings
  (audio, storage, photosensitivity) stay visible.
- **Perspective-correct mapping** on the GPU. Drag four corners per panel, directly on the wall.
- **Undo/redo for mapping** (⌘Z / ⌘⇧Z, Ctrl+Z / Ctrl+Y): corner moves, nudges, adding and removing panels, reset and import.
- **Zoom loupe** around the corner you're dragging or nudging, with neighbouring panel edges and a pixel readout. Hold **Shift** while dragging for one-tenth speed.
- **Separate projector window.** Controls stay on the laptop; output goes fullscreen on the projector.
- **Two projectors from one laptop.** Under *Projector*, click **Add a second projector**, name each one (say Backdrop
  and Gator) and open a window for each. Every projector gets its own window, its own flip, and its own panels: pick
  which projector a panel is on under its settings (*On projector*, undoable). Both windows are drawn by the same loop
  from one clock and one audio analysis, so the water on one and the light on the other move together. The live copy
  here shows one projector at a time; pick a panel, or use the buttons in its caption bar, to switch. A projector
  without an open window shows nothing, and the pre-show check says so.
- **Eyes that look alive on their own.** The eye blinks at random (set *Blinks per minute*; doubles happen now and
  then) and lets its gaze drift slowly (*Eye wander* and *Wander pace*), on top of the manual open and pupil settings,
  so it keeps living with nobody at the controls. Both eyes share one set, so they blink and look together. *Blink*
  works any time, from the button or a learned MIDI pad. Set blinks or wander to 0 to stop them.
- **Images and height maps.** Add PNG, JPEG or WebP files under *Images*; they're stored in the browser like videos.
  A panel shader that reads an image (the reptile skin's *Height map*) gets a picker for it in the panel's settings.
  A height map is greyscale, white nearest the projector, and covers exactly its panel: the skin uses it to light the
  relief, size the scales and shadow the folds. Without one it reads flat grey. Images over 4096 px are scaled down,
  and 16-bit PNGs load as 8-bit, so blur the map slightly to avoid visible steps.
- **Mesh warp for curved surfaces.** Set a panel's *Warp* to a 3 × 3 to 6 × 6 mesh and drag the pink grid points onto a
  curved surface such as an upturned bowl; the picture bends smoothly through every point (no kinks between them). The
  mesh starts from the panel's current four-corner fit, changing its size keeps the shape, and *4 corners* returns to the
  flat warp. Arrow keys nudge the last point touched, the loupe works on grid points, dragging the panel's number moves
  the whole mesh (and its mask), and undo covers it all. Text, edge softness, masks and flips work on mesh panels too.
- **Freeform masks.** Give a panel a mask (*Add mask* under its settings) to clip it to any outline, such as a
  sculpted head or one eye. Drag the blue points onto the edge of the surface, click the dashed outline to add a point,
  double-click a point to switch it between a curve and a corner, Option/Alt-click to delete it, and nudge the last
  one with the arrow keys; the loupe shows the outline up close. *Mask feather* fades the edge inwards so no light
  spills past the line; *Show outside the outline* inverts it. Masks are drawn on the projector's picture (mirrored
  with a flipped output), move with the panel when you drag its centre, are part of the mapping (undo, export) and
  are left alone by cues. The test grid ignores them so corners stay easy to line up.
  **Cut out from photo…** takes a photo of the real cutout (warm board against a paler wall or floor), finds the board and
  uses its exact outline as the mask, cropped so the panel's corners belong on the board's corners. **Pictures:** a library
  image can be a panel's content (pick it under *Pictures* in the panel's source list); transparent areas stay dark and
  the picture is cropped to its shape, so it fills the panel. **Use picture as mask…** makes the picture itself the mask: white (or opaque) shows the panel, the rest hides it, so holes
  such as eyes and separate pieces survive. It lies on the panel's own surface, so it follows corners and mesh; it has no
  points to edit, and feather softens its edge. **Trace outline…** instead turns a cutout image into an editable outline: it uses the picture's transparency,
  or white-on-black brightness for a flat image, traces the biggest shape (holes such as eyes are ignored, since a mask
  is one outline) and simplifies it to at most 48 editable points. *Picture fills panel* lays the whole image on the
  panel; *Shape fills panel* stretches just the shape's bounds over it. Undoable, and it keeps your feather and invert.
- **Layers.** Panels on a projector stack in list order, later ones on top, so a head, two eyes and a shadow can be
  separate overlapping panels. Each has a **Blend** (Normal, Add, Screen to brighten what's beneath, Multiply to darken
  it) and an **Opacity**; **Send back** and **Bring forward** reorder them (undoable). The test grid shows every panel
  as Normal so outlines stay visible while mapping. Cues store blend and opacity, and fade opacity smoothly.
- **Rear and ceiling projection.** Under *Projector*, flip the output left–right (projector behind the screen) or upside
  down (ceiling mount). Only the projector's picture is mirrored: the live copy, the corner dots you drag and the arrow
  keys all work as the audience sees the surface. Dots on the wall land where the picture does. If the projector has its
  own Rear or Ceiling mode, use that instead and leave these off.
- **Live copy of the projector** in the control window while the projector window is open. Drag corners,
  nudge and use the loupe there; changes go to the wall straight away, and the wall stays clean unless you
  tick **Dots on the wall**.
- **Beat-synced scene changes and crossfades.** Automatic changes happen every 1–32 bars, counted in kicks, and land on a kick.
  Scene changes and cue recalls crossfade over 1–8 beats at the live tempo, with both looks animating during the blend.
  *Transition* (under *Visuals*) sets how the change looks: a crossfade, a **ripple wipe** spreading from each panel's
  centre with a ring of light, a **sparkle dissolve** where the new look grows through the old in glinting specks, or
  a **fade through black**. Cues keep the transition they were saved with.
- **Post effects per projector.** *Post effects* on the Perform tab add a finishing pass over each projector's whole picture:
  **Bloom** (light spilling around bright areas), **Water shimmer** (a slow refraction, as if seen through water),
  **Tint** with a colour wheel, **Saturation** and **Vignette**. They're learnable to MIDI, ease smoothly, and are
  kept in cues. At their defaults the pass is skipped and costs nothing.
- **Twelve generated scenes** rendered at 1080p: Pulse, Spectrum, Scan, Grid, Tunnel, Smoke, Kaleido (mirrored
  noise that zooms on the kick), Lasers (a fanned beam show, different beams each beat), Warp (star streaks that
  stretch with the bass), Radial (circular spectrum), Hexes (hex cells rippling out from each kick) and Glitch
  (slice displacement and RGB split on the kick).
- **Panel shaders.** Besides the wall scene and videos, a panel can show a shader written for its surface, picked
  under *Panels* → *Panel shaders*. For the backdrop: **Bioluminescent water** (teal caustics over deep water, with
  drifting plankton that twinkles and flares on the kick), **Jellyfish** (glowing bells rising and swaying, pulsing on
  the kick, tentacles trailing), **Light shafts** (rays slanting down from the surface, with surface glints and marine
  snow), **Kick ripples** (each kick drops a ring of light that spreads and bends the caustics) and **Plankton storm**
  (dense swirling plankton that thickens with the bass, teal to violet). For the gator: **Reptile skin (height map)**
  (lit scales over a sculpted head with a wet sheen, glowing grooves, a glow wave rolling across, breathing, a reveal
  radius and the water's caustics on the same clock) and **Reptile eye** (a glowing slit-pupil eye for a curved bowl:
  eye open, pupil position and width, iris glow, colour and pulse, a pupil that widens on the kick, and a **Blink**
  button). Each renders at its panel's own size, shares the scenes' clock and
  audio, and crossfades like any other source change. They sit apart from the twelve scenes, so number keys, cues'
  scene numbers and auto-cycle are unchanged. If the graphics driver rejects one, only its panels go black.
  Each shader's settings (caustic strength, ripple size, scale size, relief lighting and so on) appear as sliders in
  the panel's settings, apply to every panel showing that shader, and can be learned to MIDI knobs under *MIDI
  controller*. Changes ease in over about 80 ms, so knob steps never show, and speed settings slow or quicken the
  motion instead of jumping it. Values save automatically, travel with *Export layout*, and are part of cues.
- **Panel text.** Type a word or two (line breaks allowed) under a panel's settings and it sits centred on that panel,
  warped with its perspective. Rotate it freely or in 90° steps for panels hung sideways; it shrinks to fit so it never
  runs off the edge. Pick a size and colour, and tick *Text pulses with the music* to have it follow the panel's band.
  Blackout and master brightness apply; the RGB split doesn't, so it stays readable. Text is part of the mapping and
  exports with the layout; cues don't change it.
- **Audio reactivity** from any input (USB interface or mic), with per-panel bands, kick detection, auto beat and tap tempo.
- **RGB split** on every panel, videos included: red and blue tear sideways on the kick (alternating
  direction each hit) or follow bass, mids or highs. Set the amount in *Visuals*, save it into cues, or ride it on a MIDI fader.
  Kicks are found as sudden rises in the 40–120 Hz band, so they still register over a heavy bassline or a hot input;
  input gain only scales the visuals, and Kick sensitivity (higher = fewer kicks) is the one knob for detection.
- **Test track.** Play a test track (MP3, WAV, M4A, FLAC) feeds a file through the same analysis as a line input and
  out of the speakers, looping, so you can judge reactivity at home without a mixer. The pre-show check warns while a
  test track is standing in for the live input.
- **Video library** stored in the browser (IndexedDB), so clips survive reloads and need no internet.
- **Cues with timed fades:** eight saved looks. A cue keeps the scene, colours, every panel's content, blend and
  opacity, and all panel shader settings (eye open, pupil, caustics and so on), but never the mapping: corners,
  meshes and masks stay put. Choose *Fade for new cues* (cut, or 1 to 60 seconds) before saving; recalling the cue
  fades everything over that time, scene and content crossfading while settings and opacities glide. Moving a
  slider mid-fade takes over at once. Cues saved before fade times existed fade over the beat-based scene fade and
  leave settings, blend and opacity alone.
- **MIDI controller** support with learn mode for scenes, cues, blackout, flash, tap tempo, faders and every panel shader setting.
- **Offline:** after one online visit, the app loads with no connection.
- **Keeps the screen awake** during the show (Wake Lock API).
- **Pre-show check:** a live checklist (audio signal, frame rate, fullscreen, power, wake lock,
  offline cache, videos decoding, leftover blackout or test grid) with a fix for each item.
- **Audio-loss fallback:** if the input goes silent for 5 seconds or the interface is unplugged, visuals
  switch to a full-strength auto beat, switch back when sound returns, and reconnect on replug.
- **Keeps drawing through faults.** A frame that throws is reported in the control window and the next one draws as
  normal, instead of freezing the wall. If the graphics driver rejects the scene shader, generated panels go black
  while videos and text keep playing. Saved and imported cues and MIDI mappings are checked on load, so a damaged
  file can't put a broken look on the wall.
- **Phone remote.** Setup → Remote shows a QR code; scanning it opens `/remote` on a phone or tablet with
  scenes, cues, blackout, hold-to-flash, tap tempo, the level faders and every effect slider and trigger. The
  Mac keeps running the show and the remote only sends the same actions MIDI learns, so anything you can map to
  a pad works from the phone, and the buttons show what's live.
- **Mapping from the phone.** The remote's **Map** tab draws the panels as the audience sees them. Touch near a
  handle (corner, mesh point, mask point, or the cross for the whole panel) to grab it, then drag anywhere:
  the handle moves by how far your finger moves, like a trackpad, so a finger never covers or jumps the point.
  **Slow** drags at a quarter speed, **Zoom** magnifies around the handle, the arrow pad nudges 1 or 10 projector
  pixels, and Undo/Redo share the Mac's history. **Add panel** and **Delete panel** work from the phone (a delete
  names the panel, so a changed list can't remove the wrong one), and on a masked panel **Add point** (touch the
  outline and keep dragging), **Make corner/smooth** and **Delete point** edit the outline; creating a mask is
  still done on the Mac. It's off until you choose Setup → Remote → *Remote may: Run the
  show and edit mapping*, so a stray touch can't move a panel mid-show; *Only watch* turns the remote read-only.
- Edge softness, spread-one-image-across-panels, test grid, blackout, master brightness.

## Run locally

```bash
npm install
npm run dev        # http://localhost:3000
npm test           # unit tests (homography, state, cues)
npm run build      # static export into ./out
npm start          # serve the production build
```

## Deploy to Vercel

Option A: push this folder to a GitHub repo, then **Import Project** in Vercel. It detects
Next.js automatically; no settings needed.

Option B, from this folder:

```bash
npx vercel          # preview
npx vercel --prod   # production
```

HTTPS matters: microphone input, MIDI, wake lock and offline caching only work on a
secure origin (your Vercel URL or localhost).

## Phone remote setup

The phone and the Mac talk through [Ably](https://ably.com) (free plan: 6 M messages a month, 200 connections;
a show with one phone uses a tiny fraction). Both load the same Vercel site, so there's nothing to run locally.
Both need internet; the Mac still works fully offline, only the remote needs a connection.

1. Create a free Ably account and an API key whose **capability is only publish and subscribe on channels
   `panelmapper:*`**. The key is built into the page, so never use a root key.
2. Put it in `.env.local` as `NEXT_PUBLIC_ABLY_KEY=...` (see `.env.example`) and add the same variable in the
   Vercel project's Environment Variables, then redeploy.
3. On the Mac: Setup → Remote → **Turn remote on**, scan the QR code with the phone.

The code in the link is the only thing keeping others out of your show, and it never leaves the link's `#`
part. Use **New code** if it leaks; every paired phone is cut off. A held flash lets go by itself after 8 s if the
phone drops. Without a key, the remote runs in a test mode between two tabs of one browser.

Ably's SDK can't be compiled by Next, so its prebuilt browser file is served from `public/vendor/ably.min.js`.
After upgrading the `ably` package, run `npm run vendor` to refresh it.

## First-time setup on the show laptop

1. Open your Vercel URL in **Chrome or Edge** while online. Wait for "Works offline" under the title.
2. Install it: the install icon in the address bar, or menu → *Install Panel Mapper*.
3. Click **Start audio input** once and allow the microphone. On macOS, also allow Chrome under
   System Settings → Privacy & Security → Microphone.
4. Click **Open projector window** once and allow pop-ups if asked.
5. Add your video loops (MP4 H.264 or WebM plays most reliably).
6. If you use a MIDI controller, open *MIDI controller*, connect, and learn your pads and knobs.

## At the venue

1. Projector set to **extend**, not mirror. Laptop on power, Do Not Disturb on.
2. Open the app, click **Open projector window**, drag it to the projector, click inside it, press **F**.
3. Turn on the test grid (**G**) and drag the corner dots in the live copy on the laptop onto each panel.
   Tick **Dots on the wall** if you want to see them on the surface while fine-tuning.
4. Start audio and set the gain so the bass meter peaks around three quarters. If the kick light misses beats, lower
   Kick sensitivity; if it fires on the bassline or snares, raise it.
5. Save a few looks into cues, untick **Dots on the wall** (or press **E**), and go.
6. **Export layout** after mapping, so each venue has a backup.
7. Open **Pre-show check** and work down it until it reads *All clear* (the dots item turns OK once the wall shows no dots).

## Keyboard

| Key | Action |
| --- | --- |
| E | Show mode (hide mapping dots) |
| F | Fullscreen the window you're in |
| H | Hide or show controls |
| B | Blackout |
| G | Test grid |
| Space | Flash while held |
| T | Tap tempo |
| 1–9, 0, -, = | Switch scene (1–12) |
| Shift + 1–8 | Recall cue |
| Arrows | Nudge the last corner touched (Shift for 10 px) |
| Shift + drag | Move a corner at one tenth of the speed |
| ⌘Z / Ctrl+Z | Undo a mapping change |
| ⌘⇧Z / Ctrl+Y | Redo |

## How it's built

```
app/                 Next.js shell (layout, page, global styles)
src/components/      React UI: control panel and app shell
src/lib/engine.ts    Render loop, projector window, keyboard, MIDI dispatch, wake lock, offline
src/lib/renderer.ts  WebGL2 renderer: scene pass into a 1080p texture (a second one for the outgoing scene while crossfading), then one pass per panel
src/lib/shaders.ts   GLSL for the scenes and the perspective-correct panel warp
src/lib/fx/          Panel shaders: typed definitions (params, image inputs, render scale), shared GLSL prelude with caustics; water, jellyfish, light shafts, kick ripples, plankton storm, reptile skin and eye (tested)
src/lib/post.ts      Post effects per projector: settings groups, when the pass runs, tint colour (tested)
src/lib/homography.ts  Unit-square-to-quad projective math (tested)
src/lib/audio.ts     Web Audio analysis: bands, kick detection, spectrum, auto beat, tap tempo, silence/unplug fallback (tested)
src/lib/transitions.ts Beat length from kick spacing, bar counting, crossfade timing (tested)
src/lib/preflight.ts Pre-show check rules (tested); the engine gathers the snapshot
src/lib/mesh.ts      Mesh warp: Catmull-Rom grid surface, resampling, tessellation, validation (tested)
src/lib/mask.ts      Freeform masks: outline curves, point insertion, validation, feathered rasterising (tested)
src/lib/trace.ts     Masks from pictures: exact picture masks and silhouette tracing to ≤48 points (tested)
src/lib/text.ts      Panel text: fit-to-panel sizing and rotation, drawn to a bitmap the panel shader overlays (tested)
src/lib/effects.ts   Audio-driven panel effects: RGB split amount and direction (tested)
src/lib/remote.ts    Remote protocol: checked actions, state snapshot, pairing code, fader throttle (tested)
src/lib/transport.ts Message pipe for the remote: Ably between devices, BroadcastChannel between tabs (tested)
src/lib/remoteHost.ts / remoteClient.ts  The Mac's side (applies actions, reports state and mapping, enforces the lock) and the phone's side
src/lib/remoteEdit.ts / remoteApply.ts  Mapping edits as pure functions (shared by the Mac and the phone) and their application to the Mac's panels (tested)
src/lib/surfaces.ts  Which window shows which projector, and which window drives the render loop (tested)
src/lib/output.ts    Output surface, mapping handles, fine drag, zoom loupe and the live projector copy (tested)
src/lib/library.ts   IndexedDB video and image storage
src/lib/midi.ts      Web MIDI input parsing
src/lib/automation.ts Eye automation: random blinks (seeded, with doubles) and slow wandering gaze (tested)
src/lib/params.ts    Shader and post-effect settings: live values, saving, MIDI faders, easing, cue glides and speed clocks (tested)
src/lib/store.ts     State, persistence, validation, panel, output and cue actions; settings v3 (outputs) migrated from v1/v2 (tested)
src/lib/history.ts   Mapping undo/redo: geometry-only snapshots, nudge coalescing (tested)
src/lib/loop.ts      Frame guard: keeps the render loop running when a frame throws, with throttled reports (tested)
public/sw.js         Service worker for offline use
```

Each projector window is a same-origin popup the main window renders into, with its own WebGL context,
all drawn in one loop with one audio analyser and one set of video decoders. The loop follows the first
visible projector window's frames and drops to a timer if they stall (a hidden or covered window). Video elements live in
the projector window so the browser keeps decoding them while the control window is in the
background.

While the projector window is open, the control window shows a second `Output` built as a mirror of it:
each frame, right after rendering, it copies the projector canvas into a 2D canvas (about 30 fps) shaped
like the projector window. Corners are stored as fractions of the stage, so a drag on the mirror lands
at the same spot on the wall; arrow nudges step in projector pixels.

## Known limits

- Chrome or Edge recommended. Safari and Firefox lack Web MIDI; Safari's wake lock and
  pop-up behaviour are less predictable.
- Closing the control window stops the output; closing the projector window moves output
  back to the control window.
- Private browsing blocks the video library.
- Generated scenes render at 1920×1080; videos render at their native resolution.
