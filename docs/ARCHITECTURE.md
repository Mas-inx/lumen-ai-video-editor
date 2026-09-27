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
    subtitles.ts      SRT / WebVTT parsing and writing, captions laid on the timeline
    color-math.ts     tone curves (monotone cubic), colour wheels, HSL bands
    lut.ts            .cube LUT parsing (3D and 1D, custom domains)
    clipboard.ts      copy / paste of clips and their media, across projects
    smart.ts          speech-aware edits: pauses, captions, ducking, reframing
    playback.ts       transport, clocked by the audio engine
  engine/           pixels and samples
    compositor.ts     tracks, transforms, keyframes, animations, transitions, grades, effects, masks, titles
    gl-grade.ts       the GPU grade: sharpen, keys, curves, wheels, HSL and 3D LUTs in one WebGL2 shader
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
  project/          session (new/open/save/recover, versions, collect), import, proxies, transcription, Whisper worker,
                    subtitle files, and the footage tools wired to the editor (analysis-actions.ts)
  integrations/     AI brains, Blender / HyperFrames / MCP clients
    agent-tools.ts    the tool registry every AI uses
    tools/            vision.ts (see) · inspect.ts (hear and read) · control.ts (act) · footage.ts (timelines,
                      subtitles, scenes, multicam, stabilizing, tracking, render queue) · kit.ts
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
  app-ipc.ts        file / project / export / window-capture / update IPC for the editor page only
  integrations/     Blender, HyperFrames, MCP host, Lumen's MCP server, media generation
    ai/               AI providers and OpenCode routing, effort, local agents, the Copilot's tool loop
```

## The media engine

- **Import** registers files with the main process, which serves them to the page as `lumen-media://file/…` with byte-range support, only for files the user chose (or an open project references). Mediabunny probes each file with WebCodecs for duration, size, frame rate and audio; waveforms and filmstrips are measured from the media itself.
- **Playback** draws the timeline on a canvas: video from `<video>` elements for smooth preview, images, image sequences and titles, with a three.js stage for 3D. Audio is a Web Audio graph per clip (volume, fades, keyframes, crossfades, *Studio voice*, RNNoise) feeding its track's channel and then the master bus, and the audio clock drives the playhead.
- **Export** replays the same compositor frame by frame, with video decoded frame-exactly by Mediabunny instead of `<video>`, mixes audio offline with the same graph, encodes with WebCodecs (hardware when available) and streams the file to disk in chunks. MP4, MOV, WebM, GIF, WAV and M4A.
  - Audio renders in two-second blocks, each starting a second early so compressors and limiters join seamlessly.
  - Loudness normalization measures the mix first, then renders it with the gain and a limiter.
- **Stills** for the AI reuse the export's frame feeder, drawn without disturbing the live preview. Exports swap in their frame-exact frames only while each of their frames is drawn (`withVideoFrames`), so the preview keeps playing live while the render queue works.
- **Transparent exports** draw with a cleared background instead of the timeline colour: a folder of numbered PNGs, or WebM whose alpha Mediabunny encodes as a second VP9 stream.

## Timelines and nesting

A project holds several timelines. The open one lives in the project's top-level `settings`, `tracks`, `clips`, `markers`, `range` and `master`, so every command, panel and tool edits it unchanged; the others wait in `project.sequences`. `sequence.open` swaps them — an ordinary command, so undo steps back through it — and each timeline keeps its own playhead.

A clip with `sequenceId` plays another timeline. `sequenceView()` presents a stored timeline as a project of its own (sharing media, LUTs and fonts), and:

- **The compositor** draws a nested timeline one level down into a canvas of the size it will cover. Scratch canvases are per level, and players and frame decoders are keyed by the path of nested clips leading to them, so a timeline nested twice plays twice. A multicam clip draws only its angle's track, and can hand every angle to the angle viewer in the same pass so all cameras keep playing.
- **The audio engine** mixes a nested timeline through its own track buses into a gain stage for the clip that plays it (its volume, fades and crossfades), mapped onto the played timeline by an offset — recursively, for playback and export alike.
- **Loops** can't happen: a timeline can't be nested in anything it contains (`wouldLoop`), and the open timeline is never looked up as a nested one.

## Reading the footage

Scene detection, multicam sync, tracking and stabilization decode media with Mediabunny (never the preview's players) and write their results through commands, so they undo like any edit:

- **Scenes:** each frame (96 px wide) is compared with the last in hue, saturation and brightness; a cut is a jump several times its neighbours' average and above a floor, kept a minimum shot apart.
- **Multicam:** every recording's sound becomes an onset envelope (rises in loudness, 100 per second); FFT cross-correlation against the reference finds the offset, refined within ±30 ms at 1 kHz.
- **Tracking:** a patch is matched frame to frame by normalized cross-correlation, coarse at half size then refined to a fraction of a pixel, following its speed and slowly updating its template. Results map through the footage's placement (fit, transform, stabilization) into what follows: `clip.follow` or `mask.follow`, offsets applied at render time.
- **Stabilization:** a grid of blocks is matched between consecutive frames; the camera's shift and turn are fitted from the blocks that agree (things moving on their own are dropped) and summed into a path. At render time the path is smoothed (Gaussian, `smooth` seconds) and the difference is taken out of the picture, zoomed to hide the edges.

## AI

**Brains.** The Copilot runs on one of:

- **Your own Claude Code or Codex.** Lumen finds the CLI and runs it headless for each message — `claude -p --output-format stream-json` with only Lumen's MCP tools (no shell, file or web tools), or `codex exec --json` in its read-only sandbox — wired to Lumen's MCP server for that run. Sign-in uses each tool's own login; conversations continue with `--resume` / `exec resume`. The model and effort go in as `--model` / `--effort`, or `-m` / `-c model_reasoning_effort=…`; Codex's models and each one's effort levels come from `codex debug models`, its defaults from `config.toml`.
- **A model with your API key** — Anthropic, OpenAI, Google Gemini, OpenRouter, OpenCode Zen, OpenCode Go, Ollama, LM Studio or any OpenAI-compatible endpoint — through an AI SDK tool loop in the main process. OpenCode's gateways serve each model through its family's API (Claude and MiniMax through Anthropic's, GPT and Grok through OpenAI's Responses, Gemini through Google's, open models through chat completions); Lumen routes by the [models.dev](https://models.dev) catalog OpenCode itself uses, cached for a day.

**Effort.** One scale — Low, Medium, High, Extra high, Max (and Codex's Ultra) — offered per model with only the levels it takes ([`electron/integrations/ai/effort.ts`](../electron/integrations/ai/effort.ts)). Low to Extra high use the AI SDK's portable `reasoning` setting, which each provider turns into its own (Claude's adaptive thinking and effort or a thinking budget, OpenAI's reasoning effort, Gemini's thinking level, `reasoning_effort`); Max goes through Anthropic's and OpenAI's own options. A model that refuses the setting is remembered and the run carries on at its default. Claude binds its thinking to the exact conversation, so earlier turns' thinking isn't replayed once their pictures and long results have been trimmed.

**Tools.** The registry ([`src/integrations/agent-tools.ts`](../src/integrations/agent-tools.ts)) combines the purpose-built tools in [`src/integrations/tools/`](../src/integrations/tools) with every editor command. See the [full reference](AI-TOOLS.md).

**Pictures.** Tools return `withImages(json, images)`. Over MCP they become `image` content blocks. In the AI SDK loop, Claude receives them inside the tool result; other providers get them as a follow-up user message injected before the next step (older pictures are replaced with a note to keep requests small). If a model rejects image input, Lumen remembers it and continues the run from its completed steps without re-running tools. Conversation history keeps every step's tool calls and results, minus the pictures.

**Transcription** runs Whisper on the device (transformers.js + ONNX Runtime Web in a worker, WebGPU or WASM; the model downloads once through the main process and is cached), or through OpenAI or ElevenLabs.

## Integrations

- **Blender.** Lumen finds Blender, writes a JSON spec and runs `blender -b --factory-startup -P runner.py`. The runner builds the scene — 3D titles with Lumen's fonts, a studio world for real metal reflections, baked keyframes so motion blur works; looping abstract backgrounds; or agent-written `bpy` (which needs the user's approval) — renders EEVEE to a PNG sequence and streams progress. With the BlenderMCP add-on, agents can also drive an open Blender (port 9876).
- **HyperFrames.** Compositions are HTML + GSAP. Lumen loads them in a hidden, sandboxed, transparent Chromium window with the HyperFrames runtime injected, seeks each frame with the runtime's `renderSeek` and captures PNGs — no FFmpeg or headless-Chrome download.
- **MCP host.** Any MCP server by URL (Streamable HTTP, SSE fallback) or command (stdio). One-click catalog: Higgsfield, Runway and Replicate (OAuth), fal.ai (API key), Blender MCP. OAuth runs in the browser with a loopback redirect; tokens and header keys are encrypted with the OS keychain. Tools get forms generated from their JSON Schema; image and audio results land in the project.
- **Lumen's MCP server.** A Streamable HTTP endpoint on `127.0.0.1:47910/mcp`, token-protected, refusing browser origins, forwarding every request to the editor page, which runs it through the same command system.
- **ElevenLabs.** Voiceovers (character timings become a transcript), Scribe transcription, sound effects and music through the REST API.

## Projects

`.lumen` files are JSON: the project plus, for every media file, its absolute path and its path relative to the project file — so a project folder moved to another drive or computer still finds its media. The editor autosaves a recovery copy; closing with unsaved changes asks first. One Lumen runs at a time: opening a `.lumen` file hands it to the running window.

- **Versions** live in `userData/versions/<project id>/` (so they follow a project when its file moves): one per save, one every ten minutes of unsaved editing, and one before a restore. Identical back-to-back snapshots are skipped; the newest 30 stay, older ones thin to one a day for 60 days.
- **Proxies** are made in the editor with Mediabunny (540p H.264, a key frame every second, no sound) and streamed into `userData/media/proxies/`. Projects reference them by path; a missing proxy is dropped on open and made again. Only the preview's `<video>` players use them.
- **Long audio** (over ten minutes) is never decoded whole: an `AudioStream` reads any window of the file, playback schedules eight-second chunks about twelve seconds ahead, and each export block reads just the source it needs.

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
