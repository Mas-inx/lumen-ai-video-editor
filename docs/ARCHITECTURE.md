# How Lumen works

Lumen is an Electron app: a React editor (the *renderer*) and a Node main process that owns files, secrets and integrations. This page is the map for contributors.

## Principles

- **One command bus.** Every change to a project — a drag on the timeline, a keyboard shortcut, the command palette, the Copilot, an outside agent — is a typed command dispatched through `dispatch(command, input)`. Commands have a Zod schema and a description, run on an Immer draft, and produce patches, so every edit is undoable and shows up in History. `toolDefinitions()` turns the same registry into tool schemas for the AI.
- **The AI uses the same tools as the user.** One tool registry serves the Copilot's API models, local Claude Code / Codex and external MCP clients. Agent edits are transactions tagged `source: 'ai'` — one undo step each.
- **What the AI sees is what you'll export.** Frames for the AI come from the same compositor and frame-exact decoder as export, never from the live preview.
- **Media stays where it is.** Imported files are referenced in place and served by a private protocol; projects store absolute *and* relative paths.
- **Secrets never reach the page.** API keys and OAuth tokens are encrypted with the OS keychain and used only in the main process.

## Map

```
shared/
  app.ts            files, projects, export, window capture, updates — main ↔ editor contract
  integrations.ts   integrations contract (types + IPC channel names)
  ai.ts             Copilot brains, effort scale, agent events, instructions
  skills.ts         SKILL.md parsing (the same format as Claude's skills)
  ingest.ts         frame ingest: the request contract, qualities and the master's codec strings
  capture.ts        recording: sources, settings, the picture's size, a recording's clock, the pointer as data
  brand.ts          brand kits: their shape, and the checks every kit passes before it's stored or applied
src/
  editor/           the document and its rules (framework-free, unit-tested)
    types.ts          project model — integer frames at the project's fps
    commands.ts       every mutation: Zod schema + description + run()  → agent tools
    store.ts          dispatch · undo/redo with Immer patches · transactions · savepoints
    ops.ts            timeline rules: magnetic main track, gap-seeking moves, trims, ripple, roll / slip / slide,
                      insert / overwrite, freeze frames, linked sound and groups, range removal
    timing.ts         clip time → source time: speed, speed ramps (integrated), reverse, freeze frames
    sequences.ts      timelines: switching, views of stored timelines, loops, nesting and breaking apart
    motion.ts         tracked paths (what follows a point) and stabilization corrections, read at render time
    subtitles.ts      SRT / WebVTT parsing and writing, captions laid on the timeline in four styles
    easing.ts         28 named easing curves and cubic-bezier, for keyframes and presets
    motion-presets.ts camera moves, entrances, exits and emphasis, baked into keyframes
    beat-grid.ts      a music clip's beats on the timeline, through its trims and speed
    cues.ts           what happens in a silent clip (a sender's cue sheet), through its trims and speed
    color-math.ts     tone curves (monotone cubic), colour wheels, HSL bands
    color-correct.ts  the correction: white balance in linear light, levels, shot matching by quantiles, auto balance
    lut.ts            .cube LUT parsing (3D and 1D, custom domains)
    clipboard.ts      copy / paste of clips and their media, across projects
    smart.ts          speech-aware edits: pauses, captions, ducking, reframing
    subject-frame.ts  where a shot's subject is, and where to put the picture so it stays in a reframed canvas
    storyboard.ts     the storyboard: scenes in order, their running times, and the stretch each produced scene covers now
    styles.ts         the style engine: six house styles, planned as command steps and applied as one transaction
    broll.ts          B-roll by meaning: BM25 over each media item's name, tags, description, prompt, folder and speech
    playback.ts       transport, clocked by the audio engine
  engine/           pixels and samples
    compositor.ts     tracks, transforms, keyframes, animations, transitions, grades, effects, masks, titles
    gl-grade.ts       the GPU grade: sharpen, keys, correction, curves, wheels, HSL and 3D LUTs in one WebGL2 shader
    gl-fx.ts          light and lens effects after the grade: relight, god rays, bloom & halation (one blur pyramid),
                      lens flares, particles, light leaks, vignettes
    gl-transition.ts  smart transitions on the GPU: morph, zoom through, whip pan, luma fade, colour match
    cut-match.ts      reading a cut: block-matched flow between its frames, choosing a transition, timing it to the beat
    scopes.ts         waveform, RGB parade, vectorscope and histogram of the rendered frame
    fonts.ts          built-in and embedded fonts (from files or the system), registered with the page
    three/            3D stage: 3D transitions, 3D layer effects, extruded titles
    decode.ts         probing, filmstrips, frame-exact decoding, audio streaming (Mediabunny / WebCodecs)
    stills.ts         frame-exact stills and contact sheets (the AI's eyes)
    audio-engine.ts   Web Audio playback, offline mixdown, crossfades, waveforms, speech detection
    mixer.ts          channel and master buses: EQ → compressor → limiter → fader → balance, meters
    eq-response.ts    the EQ's response curve, from the same biquads Web Audio runs
    loudness.ts       ITU-R BS.1770 loudness (LUFS), streamed block by block; peaks, clipping
    export.ts         render → encode → mux, streamed to disk; PNG frames and alpha WebM
    render-queue.ts   exports lined up with their files chosen, rendered one after another
    analysis.ts       every frame of a stretch of video, decoded small, as pixels
    scenes.ts         shot changes: frame-to-frame HSV change against its neighbours
    sync.ts           multicam sync: onset envelopes cross-correlated by FFT, refined at 1 kHz
    tracker.ts        template tracking (NCC on a two-level pyramid) and camera-motion measurement
    beats.ts          tempo, beats and downbeats: spectral flux, autocorrelation, dynamic programming
    render-cache.ts   render previews: chunk keys from what's on screen, rendering, background rendering
    render-player.ts  plays rendered chunks back, frame-exact, decoding ahead
    upscale.ts        contrast-adaptive sharpening when a lower resolution is scaled up
    preview-res.ts    the preview's resolution, stepping down while playing when it has to
    matte-gl.ts       subject mattes applied as alpha on the GPU
    encoders.ts       choosing an encoder that works here: real test encodes, fallbacks, what failed
    codec-strings.ts  codec strings at the level a size and frame rate need
    codec-repair.ts   H.264 files whose header misstates the video: the decoder config restated from the SPS
    graphics-report.ts  the graphics cards, what they accelerate, and every encoder tried
  project/          session (new/open/save/recover, versions, collect), import, proxies, transcription, Whisper worker,
                    subtitle files, and the footage tools wired to the editor (analysis-actions.ts); subject
                    mattes (segment.ts + its worker) and text behind subject (subject.ts); depth maps for relighting
                    (depth.ts + its worker); colour correction measured from footage (color-actions.ts); beat analysis (beats.ts);
                    frame ingest (ingest.ts, its encoder worker and the colour conversion)
  capture/          recording: recorder.ts (streams, start / pause / stop, clips on the timeline), the encoder
                    worker, zooms on clicks (autozoom.ts) and what they do to a clip (click-actions.ts)
  integrations/     AI brains, Blender / HyperFrames / MCP clients
    agent-tools.ts    the tool registry every AI uses
    skills.ts         built-in skills (skills/*.md) and which tools point at them
    tools/            vision.ts (see) · inspect.ts (hear and read) · control.ts (act) · footage.ts (timelines,
                      subtitles, scenes, multicam, stabilizing, tracking, render queue) · web.ts · skills.ts ·
                      subject.ts · beats.ts · color.ts (correction, relighting) · creative.ts (storyboard, styles,
                      brand kits, B-roll) · kit.ts
  features/         UI: home, timeline, preview, media and generate panels, inspector,
                    Copilot, integrations hub, command palette, export
electron/
  main.ts           window, single instance, file association
  files.ts          lumen-media:// protocol (byte ranges, allow-listed files, model cache), dialogs
  project.ts        .lumen files, recent projects, crash recovery, close guard
  versions.ts       version history: a copy per save and periodic snapshots, thinned with age
  collect.ts        Collect project: copies a project and its media into one folder
  export.ts         streamed export (and proxy) writes, image-sequence folders, destinations picked
                    now and written later (the render queue), subtitle files beside exports
  updater.ts        updates from GitHub Releases (electron-updater)
  crash.ts          a crashed or hung editor: reload onto the project (or its recovery copy) or quit, without looping
  brand.ts          brand kits stored under userData, logos copied beside them
  render-cache.ts   rendered preview chunks on disk, per project, capped at 8 GB
  offscreen.ts      offscreen windows that render exact pixels at any display scaling
  ingest.ts         the frame-ingest receiver: loopback HTTP, a two-frame queue per clip
  capture.ts        recording: what can be recorded, handing Chromium the source, the files, global keys, the helper
  gpu.ts            which graphics card to run on (decided before Chromium starts) and what it reports
  app-ipc.ts        file / project / export / window-capture / update IPC for the editor page only
  integrations/     Blender, HyperFrames, MCP host, Lumen's MCP server, media generation, skills, the web
    ai/               AI providers and OpenCode routing, effort, local agents, the Copilot's tool loop, chats
```

## The media engine

- **Import** registers files with the main process, which serves them to the page as `lumen-media://file/…` with byte-range support, only for files the user chose (or an open project references). Mediabunny probes each file with WebCodecs for duration, size, frame rate and audio; waveforms and filmstrips are measured from the media itself.
- **Playback** draws the timeline on a canvas: video from `<video>` elements for smooth preview, images, image sequences and titles, with a three.js stage for 3D. Audio is a Web Audio graph per clip (volume, fades, keyframes, crossfades, *Studio voice*, RNNoise) feeding its track's channel and then the master bus, and the audio clock drives the playhead.
- **Export** replays the same compositor frame by frame, with video decoded frame-exactly by Mediabunny instead of `<video>`, mixes audio offline with the same graph, encodes with WebCodecs (hardware when available) and streams the file to disk in chunks. MP4, MOV, WebM, GIF, WAV and M4A.
  - Audio renders in two-second blocks, each starting a second early so compressors and limiters join seamlessly.
  - Loudness normalization measures the mix first, then renders it with the gain and a limiter.
- **Stills** for the AI reuse the export's frame feeder, drawn without disturbing the live preview. Exports swap in their frame-exact frames only while each of their frames is drawn (`withVideoFrames`), so the preview keeps playing live while the render queue works.
- **Transparent exports** draw with a cleared background instead of the timeline colour: a folder of numbered PNGs, or WebM whose alpha Mediabunny encodes as a second VP9 stream.

## Render previews

- **Chunks.** The timeline is cut into 2-second chunks. Each chunk's key hashes everything that decides its pixels: the app version, the render size and settings, and every visible layer's clips with their media and nested timelines. Same key, same picture, so a chunk is reused until something on screen there changes, and undo brings renders back.
- **Rendering** replays the export's frame-exact compositor and encodes H.264 with WebCodecs. The main process writes each chunk to `userData/media/render-cache/<project id>/`, keeping at most 8 GB and dropping the oldest first.
- **Playback.** Inside a rendered chunk, the preview shows the chunk's frames (decoded ahead with Mediabunny) instead of compositing. Chunks rendered below full size are scaled up with contrast-adaptive sharpening in WebGL.
- **The bar** under the ruler marks chunks that may not play in real time (yellow) and rendered ones (green). While the editor is idle, heavy chunks render in the background, and any edit or playback stops that at once.

## Encoders

Graphics cards bring different encoders with different limits, and a driver can accept settings and then fail. So nothing is taken on trust ([`src/engine/encoders.ts`](../src/engine/encoders.ts)):

- **Tried for real.** Before an export, the encoder gets three frames at the export's size, frame rate and bitrate. An encoder that errors, produces nothing or never answers has failed. Results are remembered for the session.
- **A chain to fall down.** The codec asked for on the graphics card, then on the processor, then the other codecs the container carries (H.264 first). HEVC only exists on graphics cards.
- **Mid-export failures.** An error from the encoder, or 60 seconds without it taking a frame, marks it failed; the file is emptied and the export starts again on the next encoder. A failed disk write is told apart and not retried.
- **Levels** follow the frame rate as well as the size ([`codec-strings.ts`](../src/engine/codec-strings.ts)).
- **Decoding** falls back too: if the card's decoder throws on a file during an export, that file is read on the processor from then on.
- **Damaged stretches.** When neither decoder can read a group of frames while the rest of the file decodes, that stretch is noted and the frame before it is held through it ([`decode.ts`](../src/engine/decode.ts)). A stream is fed packets well ahead of the frame it shows, so just before a damaged stretch the reader hands the decoder only the packets up to it. The export's result lists what was held.
- **Misstated files.** Old Chromium builds (FiveM's browser) write the H.264 configuration record's constraint byte with its bits reversed, and Chromium refuses the codec string made from it. [`codec-repair.ts`](../src/engine/codec-repair.ts) sits under Mediabunny and restates such a config from the file's own SPS before a decoder sees it.

## Frame ingest

Another app sends a shot as raw frames over loopback HTTP and Lumen makes the master. The contract is in [INGEST.md](INGEST.md).

- **Receiver** (main process): checks each frame's size as it arrives and queues at most two per clip. A `PUT` is answered once its frame has room, so a fast sender waits instead of filling memory.
- **Encoder** (a worker in the editor): long-polls the receiver for frames through `lumen-media://ingest/…`, so frames never cross the editor's thread. It converts RGBA to Y′CbCr with exact BT.709 maths, encodes VP9 4:4:4 with a fixed quantizer and muxes MP4. The file's bytes go back to the page, which writes them through the same streamed writer as exports.
- **Why VP9 4:4:4, 8-bit:** it is software-encoded and software-decoded everywhere, so the picture is identical on every graphics card, and Chromium converts 8-bit 4:4:4 back to RGB exactly on the GPU. 10-bit takes a coarser path and measured worse.
- **Lossless** codes RGB directly (VP9's identity matrix) with quantizer 0, because 8-bit Y′CbCr has no code for some RGB colours. It decodes bit-exactly in Lumen's export path, in the preview and in ffmpeg.

## Recording

A screen or a window is recorded as it plays, at up to 4K and 60 fps. The user's guide, with the limits, is [RECORDING.md](RECORDING.md).

- **Source.** The main process lists screens and windows (`desktopCapturer`), and the editor names the one it wants just before calling `getDisplayMedia`; the request handler serves only the editor's own page, once, for that source. System sound rides on the same stream as a loopback track.
- **One worker per file** ([`src/capture/capture.worker.ts`](../src/capture/capture.worker.ts)): the recording with its sound, the camera, the microphone. Frames reach it as a transferred stream (`MediaStreamTrackProcessor`).
  - **No canvas.** A region is a `visibleRect` on the frame and a different size is the encoder's configured size: Chromium crops and scales on the way in, for hardware and software encoders alike. A canvas in the path could not keep up at these sizes.
  - **Encoder.** Chosen with [`tryEncoderConfig`](../src/engine/encoders.ts) — real frames at the real size, in the real-time mode a recording uses — in the order: the codec asked for on the graphics card, the other codecs on the card, then the processor. It is started on the first frame, before the recording begins, so the first recorded frame doesn't wait for it.
  - **Frame timing.** A frame's place in the file comes from its capture time, on the grid of the chosen frame rate (one that rounds onto a taken place takes the next). A source that has gone quiet for half a second has its last frame written again, one a beat, while the encoder's queue is empty. A place missed while frames are arriving is left empty: a repeat would cost encoder time the next real frame needs.
  - **Clocks.** Capture stamps frames on its own clock. The smallest difference seen between a stamp and its arrival maps that clock to the page's; sound is placed the same way, so the two stay together.
  - **A new file, not a failure.** An encoder that errors, or a source that changes size, ends the file and the next one starts on the next encoder that works.
- **Files** are fragmented MP4 written through the export's streamed writes, so a crash loses at most the last fragment. On stop the main process rewrites the file as an ordinary MP4 with Mediabunny (packets copied, nothing encoded). A `.partial` left in the recordings folder is offered for recovery at the next start.
- **The helper** ([`native/capture-helper`](../native/capture-helper), C#, built with the compiler that ships with Windows, about 40 KB) does what Chromium can't: one app's sound through WASAPI process loopback, the pointer's position and buttons 120 times a second, and windows' process names and rectangles. It streams over stdout and stops when its stdin closes.
- **The pointer as data** is stored on the media item as fractions of the recorded picture ([`shared/capture.ts`](../shared/capture.ts)). [`autozoom.ts`](../src/capture/autozoom.ts) turns clicks into `scale` / `x` / `y` keyframes; highlights are short title clips.
- **Colour.** Capture labels its frames BT.601 whatever the screen is; the file's colour box is rewritten to say BT.709, or Display P3 when the user picks the screen's own gamut.
- **Agents** go through [`src/integrations/tools/capture.ts`](../src/integrations/tools/capture.ts); the first call asks the user, once per session.

## Timelines and nesting

A project holds several timelines. The open one lives in the project's top-level `settings`, `tracks`, `clips`, `markers`, `range` and `master`, so every command, panel and tool edits it unchanged; the others wait in `project.sequences`. `sequence.open` swaps them — an ordinary command, so undo steps back through it — and each timeline keeps its own playhead.

A clip with `sequenceId` plays another timeline. `sequenceView()` presents a stored timeline as a project of its own (sharing media, LUTs and fonts), and:

- **The compositor** draws a nested timeline one level down into a canvas of the size it will cover. Scratch canvases are per level, and players and frame decoders are keyed by the path of nested clips leading to them, so a timeline nested twice plays twice. A multicam clip draws only its angle's track, and can hand every angle to the angle viewer in the same pass so all cameras keep playing.
- **The audio engine** mixes a nested timeline through its own track buses into a gain stage for the clip that plays it (its volume, fades and crossfades), mapped onto the played timeline by an offset — recursively, for playback and export alike.
- **Loops** can't happen: a timeline can't be nested in anything it contains (`wouldLoop`), and the open timeline is never looked up as a nested one.

## Light and colour

- **The grade** runs in one WebGL2 shader per clip ([`gl-grade.ts`](../src/engine/gl-grade.ts)). Its first stage is the **correction** — white balance (gains in linear light), levels and a shot match — composed on the CPU into one curve per channel and looked up from a half-float table, so the whole correction costs three texture reads.
- **Light and lens effects** ([`gl-fx.ts`](../src/engine/gl-fx.ts)) run after it, on the layer: relight → god rays → bloom & halation → lens flare → light leak → vignette.
  - Bloom and halation share one bright pass and a dual-filter blur pyramid (half size down to 1/64); each mixes the pyramid's levels with its own weights, so a radius is a smooth bell over the levels and a wider glow spreads the same light instead of brightening.
  - God rays are a radial blur of the bright parts toward the light (Mitchell, *GPU Gems 3*, ch. 13); flares, leaks and vignettes are drawn analytically, in fractions of the frame, so every render size looks alike.
  - A light that *follows* is found per frame from a 48-pixel-wide copy of the layer (the centre of its brightest pixels), with no state between frames, so exports and stills match the preview.
  - Glows spill into see-through parts of a layer as premultiplied light, faded before the layer's own edge; rays and flares stay inside the shot.
- **Particles** are drawn analytically too: a grid scrolls with the particles' velocity, one particle per cell at a hashed place, a layer per depth with its own scale and speed. Thousands cost a few lookups a pixel, and every frame of an export draws the same ones.
- **Smart transitions** ([`gl-transition.ts`](../src/engine/gl-transition.ts)) draw each shot on its own and carry one into the other with what was read at the cut ([`cut-match.ts`](../src/engine/cut-match.ts), [`transition-actions.ts`](../src/project/transition-actions.ts)): the last frame of the outgoing shot and the first of the incoming one, from the media itself. A 24 × 14 flow field comes from the tracker's coarse-to-fine block matching between them (outliers out by a median, holes filled from neighbours, softened); subjects from the reframing focus finder; the camera's motion from the stabilizer's frame motion; colour curves from the shot matcher. The reading is stored on the transition, so preview and export draw the same; one set without a reading (dragged on, pasted, set by an agent) is read in the background. Beat timing never moves a cut: the transition is centred on it, or starts or ends at it, so its middle — where the shots swap — lands on the beat.
- **Relight** shades the picture with a point light: surface directions come from the clip's depth map (or, without one, a soft relief from its brightness), with wrap lighting, distance falloff and a Blinn–Phong highlight.
- **Depth maps** are made like subject mattes: Depth Anything V2 (small) in a worker, at up to 30 frames a second, 640 pixels wide. Monocular depth comes out on a different scale every frame, so the range is held steady (2nd–98th percentiles, eased frame to frame) and small changes are blended with the frame before. The map is a grayscale H.264 video kept as a hidden media item, decoded beside the clip like a matte.
- **Measuring footage** for auto balance, levels and matching reads small frames of the media itself (never the graded preview). Auto balance is grey world in linear light without near-black, blown-out or strongly coloured pixels — selected by their average, which favours no channel. A match maps each channel's quantiles onto the reference's (after the reference's own correction), with slopes limited so a small sample can't stretch the footage wildly.

## Reading the footage

Scene detection, multicam sync, tracking and stabilization decode media with Mediabunny (never the preview's players) and write their results through commands, so they undo like any edit:

- **Scenes:** each frame (96 px wide) is compared with the last in hue, saturation and brightness; a cut is a jump several times its neighbours' average and above a floor, kept a minimum shot apart.
- **Multicam:** every recording's sound becomes an onset envelope (rises in loudness, 100 per second); FFT cross-correlation against the reference finds the offset, refined within ±30 ms at 1 kHz.
- **Tracking:** a patch is matched frame to frame by normalized cross-correlation, coarse at half size then refined to a fraction of a pixel, following its speed and slowly updating its template. Results map through the footage's placement (fit, transform, stabilization) into what follows: `clip.follow` or `mask.follow`, offsets applied at render time.
- **Beats:** onsets are spectral flux at about 11 kHz. The tempo comes from their autocorrelation, leaning towards 120 BPM. Beats are tracked by dynamic programming (Ellis), and downbeats are found from low-frequency flux. The grid is stored on the media, drawn on the waveform, and used as snap targets.
- **Transitions** belong to the clip after the cut (`transitionIn`), with an `align` saying where they sit: before the cut, centred on it, or after it. `transitionAt` in [`ops.ts`](../src/editor/ops.ts) answers which transition plays at a frame for the compositor, the export and the render cache; before its own start, the second clip is drawn from the footage ahead of its in-point.
- **Subject mattes:** transformers.js runs background removal in a worker: MODNet for people, or IS-Net for any subject on WebGPU. If the graphics card fails on a model, the processor takes over for it.
  - Frames are 768 px wide and steadied frame to frame.
  - The matte is saved as a grayscale H.264 video (a PNG for a still): a hidden media item linked to its footage, and removed with it.
  - The compositor turns it into alpha on the GPU, the same way in preview and export.
- **Stabilization:** a grid of blocks is matched between consecutive frames; the camera's shift and turn are fitted from the blocks that agree (things moving on their own are dropped) and summed into a path. At render time the path is smoothed (Gaussian, `smooth` seconds) and the difference is taken out of the picture, zoomed to hide the edges.

## AI

**Brains.** The Copilot runs on one of:

- **Your own Claude Code or Codex.** Lumen finds the CLI and runs it headless for each message — `claude -p --output-format stream-json` with only Lumen's MCP tools (no shell, file or web tools), or `codex exec --json` in its read-only sandbox — wired to Lumen's MCP server for that run. Sign-in uses each tool's own login; conversations continue with `--resume` / `exec resume`. The model and effort go in as `--model` / `--effort`, or `-m` / `-c model_reasoning_effort=…`; Codex's models and each one's effort levels come from `codex debug models`, its defaults from `config.toml`.
- **A model with your API key** — Anthropic, OpenAI, Google Gemini, OpenRouter, OpenCode Zen, OpenCode Go, Ollama, LM Studio or any OpenAI-compatible endpoint — through an AI SDK tool loop in the main process. OpenCode's gateways serve each model through its family's API (Claude and MiniMax through Anthropic's, GPT and Grok through OpenAI's Responses, Gemini through Google's, open models through chat completions); Lumen routes by the [models.dev](https://models.dev) catalog OpenCode itself uses, cached for a day.

**Effort.** One scale — Low, Medium, High, Extra high, Max (and Codex's Ultra) — offered per model with only the levels it takes ([`electron/integrations/ai/effort.ts`](../electron/integrations/ai/effort.ts)). Low to Extra high use the AI SDK's portable `reasoning` setting, which each provider turns into its own (Claude's adaptive thinking and effort or a thinking budget, OpenAI's reasoning effort, Gemini's thinking level, `reasoning_effort`); Max goes through Anthropic's and OpenAI's own options. A model that refuses the setting is remembered and the run carries on at its default. Claude binds its thinking to the exact conversation, so earlier turns' thinking isn't replayed once their pictures and long results have been trimmed.

**Tools.** The registry ([`src/integrations/agent-tools.ts`](../src/integrations/agent-tools.ts)) combines the purpose-built tools in [`src/integrations/tools/`](../src/integrations/tools) with every editor command. See the [full reference](AI-TOOLS.md).

**Pictures.** Tools return `withImages(json, images)`. Over MCP they become `image` content blocks. In the AI SDK loop, Claude receives them inside the tool result; other providers get them as a follow-up user message injected before the next step (older pictures are replaced with a note to keep requests small). If a model rejects image input, Lumen remembers it and continues the run from its completed steps without re-running tools. Conversation history keeps every step's tool calls and results, minus the pictures.

**Chats.** Each project keeps its chats in `userData/copilot/chats/<project id>.json`. Beside them are each chat's model history and its Claude Code or Codex session, so a chat continues where it left off, even after a restart.

**Thinking** streams as it arrives:

- the AI SDK's reasoning parts: Claude's thinking, OpenAI's reasoning summaries and Gemini's thoughts, which are asked for;
- Claude Code's thinking blocks;
- Codex's reasoning items.

Claude on an API key is asked for `display: 'summarized'`; without it, recent Claude models think in silence.

**A reply is a transcript.** Every brain reports the same events ([`shared/ai.ts`](../shared/ai.ts)): a step starting, thinking, text, a tool call being written (with how much has arrived), a tool starting and ending (with what came back), notes, and the usage at the end. In the chat, a pure reducer ([`src/features/copilot/transcript.ts`](../src/features/copilot/transcript.ts)) folds them into an ordered list of parts plus one *activity*: what is happening right now and since when. The panel draws that list; nothing is inferred from timing. Tools report their own progress to the chat through `ctx.progress`.

**Queue and stop.** A message sent while a reply is in progress is queued in the chat's store and sent when the reply ends (the queue waits after an error). Stop finalises the reply in the chat at once and ignores anything that arrives late, aborts the tool calls of that run in the renderer (each call carries its run's id and an `AbortSignal`), and tells the main process to abort the request.

**Prompt caching** ([`electron/integrations/ai/agent.ts`](../electron/integrations/ai/agent.ts)). A cache matches an identical prefix, in the order tools, instructions, messages, so requests are built to keep that prefix the same:

- Tools are sorted by name; the instructions hold nothing that changes between messages (the playhead and selection travel in the user's message).
- With an Anthropic key, the instructions carry a one-hour breakpoint (which covers the tools too). Two more move with the conversation: one at the end of the earlier turns, one on the latest message, re-placed before every step, so each step reads the steps before it from cache.
- History is trimmed from 80 messages to 40 in one go rather than one at a time, which would change the prefix on every message.
- OpenAI gets a `promptCacheKey` per chat; Claude models through OpenRouter get `cache_control`.
- Provider retries are done in Lumen's loop, not the SDK's, so the chat can say it is waiting. A retry continues from the steps already completed.

**Attachments** ([`electron/integrations/ai/attachments.ts`](../electron/integrations/ai/attachments.ts)). Files attached to a message are saved under `userData/copilot/attachments/<chat>/`. History stores a marker for each, and every request puts the same bytes back in its place: text inline, pictures and PDFs as file parts for models that take them. Word documents are read to text when attached. Agents that only have Lumen's tools open them with `read_attachment`.

**Skills** are SKILL.md files with a name and description in their frontmatter.

- **Where they come from:** built in, the user's own (`userData/skills`), and Claude Code's (`~/.claude/skills`, read-only, off by default).
- **How agents find them:** their index goes into the Copilot's instructions and into the MCP server's `initialize` instructions. Tool descriptions name the skill to load, and `use_skill` returns its body.

**The web.**

- **Pages** are fetched by the main process. It follows redirects itself and checks every hop's address after DNS, refusing private, loopback and link-local ones.
- **Search** uses DuckDuckGo's HTML results.
- **Screenshots** render offscreen in a separate session that blocks requests to private addresses.
- **Video links** ([`electron/integrations/video-link.ts`](../electron/integrations/video-link.ts)) are watched without importing them. The main process finds what there is, and the editor lays the frames out as contact sheets.
  - **YouTube:** the player endpoint, asked as YouTube's own apps ask it, gives the caption tracks and the *storyboard* spec — the sprite sheets of preview frames the player shows on hover. Captions become a transcript; tiles are cut from the sheets. The video itself is never downloaded.
  - **Vimeo:** the same from its player config. **X:** the post's public video file. **Other pages:** `og:video`, JSON-LD and `<video>` sources.
  - **A video file** is saved to a temporary directory (capped at 400 MB, deleted when the tool is done, swept after 15 minutes otherwise) and sampled with the editor's own decoder.
  - **yt-dlp**, only if the user has it on the PATH, opens the rest: `--ignore-config --no-playlist --skip-download -J` for the details, then one small plain-file format.
  - No cookies go out, nothing signs in, and every address — redirects and ones taken from pages and answers included — passes the same public-address check. These are not official APIs: when a site changes them, the tool says what it couldn't get.

**Transcription** runs Whisper on the device (transformers.js + ONNX Runtime Web in a worker, WebGPU or WASM; the model downloads once through the main process and is cached), or through OpenAI or ElevenLabs.

## Integrations

- **Blender.** Lumen finds Blender, writes a JSON spec and runs `blender -b --factory-startup -P runner.py`. The runner builds the scene — 3D titles with Lumen's fonts, a studio world for real metal reflections, baked keyframes so motion blur works; looping abstract backgrounds; or agent-written `bpy` (which needs the user's approval) — renders EEVEE to a PNG sequence and streams progress. With the BlenderMCP add-on, agents can also drive an open Blender (port 9876).
- **ComfyUI** ([`electron/integrations/comfyui/`](../electron/integrations/comfyui)). The user's own ComfyUI, at an address they set (http only for this computer, the LAN or a VPN; an optional auth header kept with the other secrets). Workflows live in a library under userData: API-format JSON, ComfyUI's saved format (converted with the server's `/object_info`, refusing what it can't map exactly), or a PNG ComfyUI saved. Each workflow's inputs are found from its graph — prompts told apart by the sampler socket they reach, seed, steps, size, media loaders — and a run sets them by role or by node and input. Inputs are uploaded into ComfyUI's `input/lumen/`; a run is queued with its websocket already open, followed over it (history as a fallback), and its outputs are downloaded into the project's media as a job.
- **HyperFrames.** Compositions are HTML + GSAP. Lumen loads them in a hidden, sandboxed, transparent Chromium window with the HyperFrames runtime injected, seeks each frame with the runtime's `renderSeek` and captures PNGs — no FFmpeg or headless-Chrome download.
  - **Templates** ([`electron/integrations/hyperframes/`](../electron/integrations/hyperframes)): the page and its helpers in `page.ts`, the type templates in `templates.ts`, and the particle title and charts, which draw more than they lay out, in `particle-title.ts` and `charts.ts` (chart data is read in [`shared/motion.ts`](../shared/motion.ts), shared with the Generate panel and the AI tool). Every frame is worked out from the timeline's time alone, with seeded randomness, so a frame renders the same however it's reached. A page that has to load something before it can draw — the particle title samples its own text once its font is in — registers the promise in `window.__hf.buildReady`, and no frame is captured until it settles.
  - **Display scaling:** Windows clamps a window to the work area in DIPs. So for a scale k, the window is sized at 1/k with a device scale factor of k and a zoom of 1/k. That gives exact, centred pixels at any display scaling.
- **MCP host.** Any MCP server by URL (Streamable HTTP, SSE fallback) or command (stdio). One-click catalog: Higgsfield, Runway and Replicate (OAuth), fal.ai (API key), Blender MCP. OAuth runs in the browser with a loopback redirect; tokens and header keys are encrypted with the OS keychain. Tools get forms generated from their JSON Schema; image and audio results land in the project.
- **Lumen's MCP server.** A Streamable HTTP endpoint on `127.0.0.1:47910/mcp`, token-protected, refusing browser origins, forwarding every request to the editor page, which runs it through the same command system.
  - **Long calls.** Clients stop waiting after 25 to 60 seconds. A call still working after 20 seconds answers `running` with a call id while the work carries on, and `get_tool_result` collects it ([`long-calls.ts`](../electron/integrations/long-calls.ts)).
  - **Streaming.** Tool calls answer as a stream with a keep-alive comment every five seconds and progress notifications; everything else is plain JSON.
- **ElevenLabs.** Voiceovers (character timings become a transcript), Scribe transcription, sound effects and music through the REST API.

## Projects

`.lumen` files are JSON: the project plus, for every media file, its absolute path and its path relative to the project file — so a project folder moved to another drive or computer still finds its media. The editor autosaves a recovery copy; closing with unsaved changes asks first. One Lumen runs at a time: opening a `.lumen` file hands it to the running window.

- **Versions** live in `userData/versions/<project id>/` (so they follow a project when its file moves): one per save, one every ten minutes of unsaved editing, and one before a restore. Identical back-to-back snapshots are skipped; the newest 30 stay, older ones thin to one a day for 60 days.
- **Proxies** are made in the editor with Mediabunny (540p H.264, a key frame every second, no sound) and streamed into `userData/media/proxies/`. Projects reference them by path; a missing proxy is dropped on open and made again. Only the preview's `<video>` players use them.
- **Long audio** (over a minute) is never decoded whole: an `AudioStream` reads any window of the file, playback schedules eight-second chunks about twelve seconds ahead, and each export block reads just the source it needs. At most 24 streams keep their readers open; the rest let go until they're read again.
- **Memory budgets.** Decoded short audio (512 MiB, reversed and denoised copies included), stills (512 MiB), image-sequence frames (768 MiB) and filmstrips (256 MiB) live in LRU caches ([`src/lib/lru.ts`](../src/lib/lru.ts)); whole-file decodes run three at a time, nearest the playhead first ([`src/lib/limiter.ts`](../src/lib/limiter.ts)). Video players unused for 900 drawn frames, beyond the eight most recent idle ones, are released; scratch canvases unused for 300 frames are emptied ([`scratch.ts`](../src/engine/scratch.ts)); an export's frame feeder drops a clip's decoder at the first frame that doesn't draw it.
- **A crashed or hung editor** ([`electron/crash.ts`](../electron/crash.ts)) gets a native dialog: reload onto the project (the recovery copy when it holds this project's unsaved changes) or quit. Stopping again within two minutes of a reload steps down to starting without the project, then to quitting only.

## Updates

[`electron/updater.ts`](../electron/updater.ts) uses electron-updater with the GitHub provider: shortly after launch and every four hours it reads `latest.yml` from the newest release, downloads the new installer in the background (only the changed blocks when a blockmap allows, verified against the release's SHA-512) and installs it silently when Lumen restarts — at once from **Restart to update**, otherwise on the next quit. The release workflow uploads `latest.yml` and the blockmap with every installer. Development builds don't update themselves; `LUMEN_UPDATE_URL` points a build at a local feed to try the whole flow without publishing.

## Stack

| Layer | Choice |
| --- | --- |
| Shell | Electron 44 · `vite-plugin-electron` (frameless window, native controls overlay) · electron-builder (NSIS) |
| UI | React 19 + React Compiler · TypeScript 7 · Tailwind CSS 4 · Radix primitives · Motion · cmdk · sonner |
| State | Zustand 5 + Immer patches (undo/redo) · Zod 4 command schemas |
| Media | Mediabunny (WebCodecs demux/decode/encode/mux) · Web Audio · RNNoise (WASM) · gifenc |
| Preview | Canvas 2D compositor + three.js stage for 3D |
| Speech | transformers.js + ONNX Runtime Web (Whisper, WebGPU / WASM) in a worker |
| AI | AI SDK tool loops · MCP TypeScript SDK (client **and** server) |
| Tests | Vitest |
