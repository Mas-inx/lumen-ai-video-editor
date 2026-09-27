# Changelog

Every notable change to Lumen, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Lumen uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Pro trim tools.** The **roll** (`R`), **slip** (`Y`) and **slide** (`U`) tools; hold `Ctrl` on a trim handle to **ripple trim** on any track; hold `Ctrl` while dragging clips to **insert** (push clips later) or `Shift` to **overwrite**.
- **In and out points.** `I` and `O` mark a stretch (drag its ends on the ruler); `Shift+Space` plays it, looping plays just that stretch, `;` lifts it, `'` extracts it, and the Export dialog can export only that stretch.
- **Copy, cut and paste** clips (`Ctrl+C`, `Ctrl+X`, `Ctrl+V`, `Ctrl+Shift+V` to paste as an insert), also between projects, and **paste attributes** (`Ctrl+Alt+V`) to copy transform, crop, color, effects, audio, speed, animation, text style or blend mode onto other clips.
- **Crop** with rounded corners: sliders, aspect presets (16:9, 1:1, 9:16, 4:5, circle) and a crop box to drag on the canvas.
- **Freeze frames** (`Shift+F`) and **speed ramps**: presets such as Montage, Hero and Bullet, or shape the curve yourself. Ramps keep the same footage, and the sound follows the ramp.
- **Detach audio** (`Ctrl+L`) onto its own clip, linked to the picture, for J- and L-cuts; it stays in sync when the main track moves. Reattach it any time.
- **Groups** (`Ctrl+G`): grouped and linked clips select, move and cut together; hold `Alt` to pick just one.
- **Solo** tracks, **mute** a video track's sound, and **reorder tracks** by dragging.
- 14 new AI tools for all of the above.
- **A mixer** (the new Mixer tab). Every track that makes sound gets a channel strip with a fader, pan, mute, solo and a live stereo meter with peak hold and a clip light; the master bus has one too, and a slim master meter sits by the transport.
  - Each channel, and the master, can have an **EQ** (low cut plus low, mid and high bands, with a response curve you drag), a **compressor** and a **limiter**, with live gain-reduction readouts, and presets such as *Clear voice*, *Music under voice* and *Finished master*.
  - Faders, pan and processing change smoothly while playing, and the export renders exactly the same mix.
- **Crossfades.** Transitions now crossfade the sound as well as the picture (equal power), and audio tracks show a + at each cut to add one; `Ctrl+Shift+D` crossfades the selected clip with the one before.
- **Loudness normalization** in the Export dialog: −14 LUFS (YouTube, Spotify, TikTok), −16 (Apple, podcasts), −23 (EBU R128) or −24 (ATSC A/85). Lumen measures the whole mix first, then sets its level with peaks held under the ceiling. The AI's `export_video` takes a `loudness_lufs` target too.
- `mix_update` gives the AI the mixer.
- **Colour grading on the GPU.** Curves (master and red, green, blue), colour wheels (lift, gamma, gain, each with a brightness slider), HSL for eight colour ranges, and **.cube LUTs** (3D and 1D) imported into the project with an amount slider. Clips that don't use them keep the fast path, and look the same either way.
- **Scopes** beside the program monitor: waveform, RGB parade, vectorscope (with colour targets and the skin-tone line) and histogram.
- **Keys:** *Chroma Key* (green or blue screen, a custom colour or an eyedropper that samples the unkeyed picture; tolerance, softness and spill suppression) and *Luma Key*.
- **Masks:** feathered ellipse and rectangle masks with roundness, opacity and invert, edited on the canvas. On an adjustment layer they limit the grade to part of the frame.
- **Titles:** outlines, and any font — import a font file or pick one installed on your computer; it's embedded in the project so it opens the same anywhere, 3D titles included.
- *Sharpen* now actually sharpens.
- 7 new AI tools (masks, LUTs and fonts), and effects take settings, for 91 AI tools in all.

- **OpenCode Go** as a Copilot brain: paste your OpenCode Go key and pick from GLM, Kimi, DeepSeek, Qwen, MiniMax, MiMo, Grok, GPT Luna and the rest of its models.
- **Choose the model and effort for every brain.**
  - Claude Code gets its default plus Fable, Opus, Sonnet and Haiku.
  - Codex gets its full model list, read from Codex itself, with your `config.toml` default shown.
  - Every API model is listed too.
  - A new effort picker next to the model offers Low, Medium, High, Extra high and Max — only the levels the chosen model supports — and Ultra on Codex models that have it.
- **Automatic updates** from the GitHub Releases page.
  - Lumen checks shortly after launch and every few hours, and downloads a new version in the background.
  - It installs when you restart: from the **Restart to update** button or notification, or the next time you quit.
  - **Check for updates** lives in the Lumen menu, and the About box shows progress and release notes.

### Fixed

- A video at a speed other than 1× now plays smoothly in the preview; before, it played at normal speed and kept jumping to catch up.
- `Shift+←` and `Shift+→` move one second at any frame rate, not 30 frames.
- The sound under a video transition now crossfades instead of cutting hard at the edit.
- Lumen's taskbar, Start menu and desktop icons were blank after installing 1.0.2. The app's long description overflowed into the shortcuts' icon path; it's short again, and a test keeps it that way.
- Claude, GPT and Gemini models on **OpenCode Zen** now work. Each goes to the endpoint of its own family (Anthropic, OpenAI Responses, Google) instead of OpenAI chat completions. Requests also carry the client name and session that OpenCode's gateways ask for.
- Follow-up messages to Claude Opus 5.5 and Fable 5.1 no longer risk being rejected. Earlier turns' thinking isn't replayed once their pictures and long results have been trimmed.
- A model that doesn't take an effort setting carries on at its default instead of failing.

## [1.0.2] — 2026-09-23

### Added

- **The AI can see and hear.** Every AI brain — API models, your own Claude Code or Codex, and outside agents over MCP — now shares a toolset of about 70 tools:
  - `get_frame` renders any moment exactly as the export will; `get_contact_sheet` lays out the whole edit as one labelled grid; `get_media_frames` looks inside footage; `get_editor_screenshot` sees the editor window.
  - `get_transcript` (what's said and when, after every cut), `analyze_audio` (loudness in LUFS per ITU-R BS.1770, peaks, clipping, silences, per track) and `find_media` (searches inside transcripts too).
  - `get_clips_at`, `get_clip`, `get_history` and `list_catalog` for inspecting the project and finding valid ids.
  - `batch_edit` applies several commands as one undo step, all or nothing; plus `add_title`, `undo`, `redo`, `select_clips`, `playback`, `save_project` and `export_video`.
- The Copilot chat shows the pictures the AI looked at on each step; click one to enlarge it.
- Pictures reach every model: inside the tool result for Claude, as a follow-up message for other vision models. A model that can't take images is detected and carries on without them.

### Changed

- The Copilot keeps earlier steps' tool calls and results between turns, so it remembers what it looked up.
- A run that only looked at the project now says “No changes made” instead of “Edited timeline”.
- Video generation no longer names Sora, whose API OpenAI shut down on 24 September 2026; Lumen offers whichever video models your key can use (Veo with a Gemini key).

### Fixed

- The AI can edit and remove markers (their ids are now in `get_project`).
- Removing a marker or effect that doesn't exist reports an error instead of silently succeeding.
- Only one export runs at a time, whether started from the Export dialog or by the AI.
- Sound effects, music and voice land on their own tracks (Sound effects, Music, Voice) instead of the first free audio track — so effects no longer push a music bed out of place.
- The Export dialog's preview shows the real frame even for media the player hasn't loaded yet (Blender and HyperFrames renders), and *Save this frame to Media* captures the exact frame.

## [1.0.1] — 2026-09-23

### Fixed

- The editor window never appeared on launch: it waited for a first paint that the start screen's fade-in only produces once the window is visible. The window now shows as soon as the page loads.

## [1.0.0] — 2026-09-23

First release.

### Added

- **Editing** — magnetic main track, free overlay/title/caption/audio tracks, split, trim, ripple, slip into gaps, snapping, markers, speed and reverse, keyframes with easing, 2D and 3D transitions, effects, looks and colour grading, 2D titles and extruded 3D titles, undo for everything, command palette.
- **Media engine** — WebCodecs (Mediabunny) probing, filmstrips and frame-exact decoding; media referenced in place through a `lumen-media://` protocol with byte ranges; offline media and relinking; frame snapshots.
- **Sound** — Web Audio playback that drives the playhead, per-clip volume, fades and keyframes, *Studio voice*, RNNoise noise reduction, 15 built-in sound effects.
- **Export** — MP4 (H.264, HEVC, AV1), MOV, WebM (VP9, AV1), GIF, WAV and M4A, 480p to 4K, 24–60 fps, hardware encoding, size estimate, progress and cancel.
- **Projects** — `.lumen` files with absolute and relative media paths, crash recovery, recent projects, unsaved-changes prompt, file association.
- **AI** — Copilot powered by your own Claude Code or Codex, or a model with your API key (Anthropic, OpenAI, Gemini, OpenRouter, OpenCode Zen, Ollama, LM Studio, any OpenAI-compatible endpoint); on-device Whisper transcription; remove pauses (timeline-wide, speaker-aware), captions, music ducking, reframing; image and video generation with OpenAI and Gemini keys; ElevenLabs voice, sound and music.
- **Integrations** — Blender renders (3D titles, backgrounds, agent-written scenes), HyperFrames motion graphics, MCP host (Higgsfield, Runway, Replicate, fal.ai or any server) and Lumen's own MCP server for external agents.
- Windows installer (NSIS, per-user or all-users).

[Unreleased]: https://github.com/Mas-inx/lumen-ai-video-editor/compare/v1.0.2...HEAD
[1.0.2]: https://github.com/Mas-inx/lumen-ai-video-editor/releases/tag/v1.0.2
[1.0.1]: https://github.com/Mas-inx/lumen-ai-video-editor/releases/tag/v1.0.1
[1.0.0]: https://github.com/Mas-inx/lumen-ai-video-editor/releases/tag/v1.0.0
