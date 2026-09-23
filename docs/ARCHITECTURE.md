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
  app.ts            files, projects, export, window capture — main ↔ editor contract
  integrations.ts   integrations contract (types + IPC channel names)
  ai.ts             Copilot brains, agent events, instructions
src/
  editor/           the document and its rules (framework-free, unit-tested)
    types.ts          project model — integer frames at the project's fps
    commands.ts       every mutation: Zod schema + description + run()  → agent tools
    store.ts          dispatch · undo/redo with Immer patches · transactions · savepoints
    ops.ts            timeline rules: magnetic main track, gap-seeking moves, trims, ripple, range removal
    smart.ts          speech-aware edits: pauses, captions, ducking, reframing
    playback.ts       transport, clocked by the audio engine
  engine/           pixels and samples
    compositor.ts     tracks, transforms, keyframes, animations, transitions, grades, effects, titles
    three/            3D stage: 3D transitions, 3D layer effects, extruded titles
    decode.ts         probing, filmstrips, frame-exact decoding (Mediabunny / WebCodecs)
    stills.ts         frame-exact stills and contact sheets (the AI's eyes)
    audio-engine.ts   Web Audio playback, offline mixdown, waveforms, speech detection
    loudness.ts       ITU-R BS.1770 loudness (LUFS), peaks, clipping
    export.ts         render → encode → mux, streamed to disk
  project/          session (new/open/save/recover), import, transcription, Whisper worker
  integrations/     AI brains, Blender / HyperFrames / MCP clients
    agent-tools.ts    the tool registry every AI uses
    tools/            vision.ts (see) · inspect.ts (hear and read) · control.ts (act) · kit.ts
  features/         UI: home, timeline, preview, media and generate panels, inspector,
                    Copilot, integrations hub, command palette, export
electron/
  main.ts           window, single instance, file association
  files.ts          lumen-media:// protocol (byte ranges, allow-listed files, model cache), dialogs
  project.ts        .lumen files, recent projects, crash recovery, close guard
  export.ts         streamed export writes
  app-ipc.ts        file / project / export / window-capture IPC for the editor page only
  integrations/     Blender, HyperFrames, MCP host, Lumen's MCP server, AI providers, media generation
```

## The media engine

- **Import** registers files with the main process, which serves them to the page as `lumen-media://file/…` with byte-range support, only for files the user chose (or an open project references). Mediabunny probes each file with WebCodecs for duration, size, frame rate and audio; waveforms and filmstrips are measured from the media itself.
- **Playback** draws the timeline on a canvas: video from `<video>` elements for smooth preview, images, image sequences and titles, with a three.js stage for 3D. Audio is a Web Audio graph per clip (volume, fades, keyframes, *Studio voice*, RNNoise) and its clock drives the playhead.
- **Export** replays the same compositor frame by frame, with video decoded frame-exactly by Mediabunny instead of `<video>`, mixes audio offline with the same graph, encodes with WebCodecs (hardware when available) and streams the file to disk in chunks. MP4, MOV, WebM, GIF, WAV and M4A.
- **Stills** for the AI reuse the export's frame feeder, drawn without disturbing the live preview.

## AI

**Brains.** The Copilot runs on one of:

- **Your own Claude Code or Codex.** Lumen finds the CLI and runs it headless for each message — `claude -p --output-format stream-json` with only Lumen's MCP tools (no shell, file or web tools), or `codex exec --json` in its read-only sandbox — wired to Lumen's MCP server for that run. Sign-in uses each tool's own login; conversations continue with `--resume` / `exec resume`.
- **A model with your API key** — Anthropic, OpenAI, Google Gemini, OpenRouter, OpenCode Zen, Ollama, LM Studio or any OpenAI-compatible endpoint — through an AI SDK tool loop in the main process.

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
