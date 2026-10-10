# Changelog

Every notable change to Lumen, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Lumen uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.5.0] — 2026-10-11

A Copilot chat you can follow, queue and stop, that takes files and video links, and costs less on an API key.

### Added

- **The Copilot chat shows everything as it happens.** A reply is now a running record, in order: what the model thought, what it said and every step it took.
  - Thinking shows live, then folds to *Thought for 12 s*; open it to read all of it. Claude models on an API key now send a summary of their thinking. Before, they sent none and the chat sat silent while they thought.
  - Each step shows while the model is still writing it (*Writing the request — 4,200 characters so far*), while it runs (with progress from exports, cut-outs, tracking and renders) and when it's done. Open a step to see what was sent and what came back.
  - There is always a line saying what's going on, with a clock: *Asking the model…*, *Waiting for the model…*, *Reading the result…*. After 20 seconds with nothing new, it says that too.
  - When a provider is busy or rate-limiting, the chat says so and tries again, up to three times, from the steps already done. No tool runs twice.
  - Each reply ends with what it used: tokens in (and how many came from cache), tokens out, steps and time. *Copy everything it did* copies the whole record.
- **Queue messages while it works.** Send while a reply is in progress and the message waits in a list above the box, then goes when the reply ends. Send one now, edit it or remove it. After an error, the queue waits for you.
- **Attach files to a message:** paste from the clipboard, drop onto the chat, or pick *From your computer…*.
  - Pictures, PDFs, Word documents and text of any kind (code, CSV, JSON, subtitles, Markdown). A long paste becomes a file, so the box stays readable.
  - Video and audio go into the media library and are attached as media.
  - Pictures need a model that can see them. PDFs go to Claude, GPT and Gemini API models. Claude Code and Codex open attachments with the new `read_attachment` tool.
- **The Copilot watches video links.** Paste a link and it sees the video itself, not just the thumbnail: frames spread across it as labelled contact sheets, what is said (a timestamped transcript from the captions), the chapters, title, author and length. Nothing is imported into the project.
  - **YouTube** (videos and Shorts) and **Vimeo** take a second or two: Lumen reads the captions and the small preview pictures the player shows when you hover the timeline, without downloading the video.
  - **A video file's link** is downloaded to a temporary file (up to 400 MB), sampled, and deleted. **Video posts on X** and pages that name their video in public work the same way.
  - Ask for a closer look at any stretch (*from_seconds*, *to_seconds*) and it gets more frames of less video. A long transcript comes in parts.
  - Other sites (TikTok, Instagram, Twitch and the like) need [yt-dlp](https://github.com/yt-dlp/yt-dlp) installed; Lumen uses it if it's on your PATH and never downloads it itself.
  - Lumen doesn't sign in or get around age and sign-in checks: for those it says so and shows what is public. YouTube and Vimeo are read the way their own players read them, which isn't an official API and can stop working when they change it.
  - Every brain can use it (`watch_web_video`), Claude Code, Codex and agents on the MCP server included.
- **Prompt caching for API models,** so a long chat costs a fraction of what it did.
  - With an Anthropic key, the tool list and instructions are cached for an hour and the conversation is cached as it grows: every step of a reply re-reads what came before at about a tenth of the price.
  - Requests are built so the cached part stays identical byte for byte: tools in a fixed order, the playhead and selection kept in your message rather than in the instructions, attachments sent the same way each time, and old history dropped in large blocks rather than a message at a time.
  - OpenAI gets a cache key per chat, and Claude models through OpenRouter get cache markers.
  - The line under each reply shows how much was read from cache.

### Changed

- **Stop stops at once.** The reply is marked stopped straight away, running work (an export, a cut-out, tracking, a video being downloaded to watch, a wait on a render) is cancelled, and anything that arrives late is ignored. Queued messages carry on. *Esc* in the message box stops too.
- **The chat stays where you're reading.** It follows new output only while you're at the bottom. Scroll up and it stays put; *Latest* (or *New below* when there is more) takes you back.
- Chats saved by earlier versions open in the new layout.

### Fixed

- In full screen, the timeline's ruler and tracks no longer show through the middle of the picture.
- **Reading a page or previewing a link failed on any address that redirects** (`http://` to `https://`, a short link, a *latest release* link) with "Redirect was cancelled". Redirects are followed again, each hop checked as before. Page requests no longer carry cookies.
- An expired Claude Code sign-in is recognised as one, so the chat offers *Sign in* instead of only the error, and the error is shown once rather than twice.

## [1.4.0] — 2026-10-07

Frames straight from other apps, exports that find a working encoder on any graphics card, and transitions you can place anywhere on a cut.

### Added

- **Transitions sit where you put them on a cut:** over the end of the first clip, centred on the cut, or over the start of the second.
  - Drag a transition to where two clips touch. The timeline shows where it will land as you move: *Before*, *On the cut* or *After*.
  - Click a transition on the timeline to move it with *Position*, change its length or swap it.
  - In the Transitions panel, select the two clips either side of a cut (or one clip next to it) and click.
  - A transition that starts before the cut shows the second clip from the footage ahead of its in-point, and the sound crossfades over the same stretch.
  - `clip_setTransition` takes `align`: `before`, `center` or `after`.
- **Track something in the clip you're on.** *Track motion* on a piece of footage with nothing under it used to end in an error. Now you box what to follow and a title is pinned to it, ready to reword. If a title or picture already lies over the footage, that one follows instead.
- **Two motion-graphic style skills** for the Copilot, ten skills built in now: fifteen named looks (flat vector, line art, isometric, Bauhaus, collage, liquid, synthwave, pixel art, HUD and more), each with the rules that make it read as that style and what breaks it. The motion design, HyperFrames, sound and Blender skills gained a structure for a whole piece, a review checklist, canvas techniques and sound-to-picture timing. The style rules are adapted from [mg-styles-15](https://github.com/Vincentwei1021/mg-styles-15) (MIT).
- **Frame ingest.** Another app on this computer can send Lumen finished frames over loopback, and Lumen encodes each shot once into a master clip in the media library. It was built for GS Cinematic Studio filming GTA V; any renderer or capture tool can use it. See [docs/INGEST.md](docs/INGEST.md).
  - Switch it on in *Integrations › Frame ingest*, which shows the address and token to copy. Agents use `ingest_start` and `ingest_status`.
  - Masters keep full colour resolution (VP9 4:4:4). Three qualities: *Master* (visually lossless, the default), *Lossless* (every pixel exactly as sent) and *Compact*.
  - They are encoded and decoded on the processor, so they look the same on every graphics card.
  - Frames are raw RGBA or BGRA, top-down or bottom-up, or PNG, at any even size up to 8K and any frame rate.
  - Large clips arrive with a small proxy, so they play smoothly at once.
  - A sender that is faster than the encoder waits; nothing piles up in memory.
  - **Cues.** A sender can say what happens in a clip (lines said, cuts, footsteps, effects), since a master has no sound. They show along the bottom of the clip on the timeline, *Add markers at the cues* puts them on the ruler, and `get_clip` gives them to agents at timeline seconds. GS Cinematic Studio sends its cue sheet with every render.
- **Graphics and encoding** (Lumen menu): which graphics card Lumen runs on, what it speeds up, and every video encoder tried with real frames at 1080p 60 and 4K 60.
  - On a computer with two cards you can ask for the fastest one.
  - A card whose driver Chromium distrusts can be used anyway.
  - *Copy report* gives a text report to paste when asking for help; the `graphics_report` tool gives agents the same.
- `export_video` takes `hardware: false` to encode on the processor, and says what encoded the file.

### Changed

- **Cutting out *any subject* uses a different model** (IS-Net, about 170 MB, downloaded once). The one before could not run on Windows graphics cards at all.
- **Full screen** covers the whole window, so menus, tooltips and messages still show while you're in it.
- **Exports choose an encoder that really works.** Before an export, the encoder is tried with a few frames at the export's size, because some drivers accept settings and then fail.
  - If the graphics card's encoder isn't there or fails, the processor's takes over. If a codec has no working encoder at all (HEVC only exists on graphics cards), the export moves to H.264.
  - If an encoder fails or stops answering part-way through, the export starts again on the next one by itself, and the result says what happened.
  - *Hardware* off now really means the processor. Before, it meant "no preference".
  - The Export dialog says what will encode the file.
- **Codec levels follow the frame rate.** 4K at 60 fps is now asked for as H.264 level 5.2, HEVC 5.1 and AV1 5.1, not the levels 4K at 30 gets.
- **Render previews** use the same tested choice, so they work on a computer with no graphics-card H.264 encoder.
- **Long tool calls through Lumen's MCP server no longer time out.** Clients gave up after about 25 to 60 seconds and reported a network error while the work carried on.
  - A call still working after 20 seconds now answers `running` with a `call_id`, and the new `get_tool_result` tool collects the result.
  - Tool calls answer as a stream with a keep-alive every few seconds, and send progress notes.
  - Tools that wait on a render wait at most 15 seconds there and hand back their job id.

### Fixed

- The full-screen button in the program monitor did nothing once you were in full screen: only `Esc` got you out. It now switches back.
- *Text behind subject* and cut-outs with *any subject* failed with "Too many storage buffers in shader". If a graphics card can't run a cut-out model, the processor now takes over where it can, and the message says what happened in plain words.
- The spinner on progress messages sat in the corner of the message instead of beside its text.
- A clip could lose its last frame on the timeline: media lengths are kept to the millisecond, and 40 frames at 30 fps (1.333 s) counted as 39.
- Subject cut-outs and the sharpening upscaler stopped working until a restart if the graphics driver was reset. They now set themselves up again.
- If the graphics card's video decoder fails on a file during an export, the processor's decoder takes over for that file.
- **An export no longer fails because part of a video can't be decoded** (a damaged or cut-short file). The preview played such files while the export stopped with "Decoding error". Now the picture before the damaged part is held through it, and the export says which file and where. Thumbnails and `get_media_frames` skip such parts too.
- **Videos rendered in FiveM's browser now import and play.** Its H.264 encoder writes one byte of the file's header backwards, and Chromium refused such files without looking at the video (black frames, "can't decode"). Lumen now reads the profile from the video itself. This covers every MP4 GS Cinematic Studio has written.
- `import_media_file` now says why a file couldn't be imported (the codec, or what the file reader made of it) instead of "No importable media found". It also takes a single `path`.
- Version history could lose a version when two were saved in the same millisecond: the second overwrote the first.

## [1.3.0] — 2026-10-03

Render previews, a Copilot that thinks out loud, and the effects editors reach for every day.

### Added

- **Render previews**, like Premiere and Filmora. A bar under the ruler shows yellow where playback may not keep up and green where a stretch is rendered.
  - Press `Enter` to render in to out (or the whole timeline), render just the selected clips, or let Lumen render heavy stretches while you're idle.
  - Rendered stretches play smoothly and frame-exact. They stay valid until what's on screen changes, and undo brings them back.
  - Render at Full, 1/2, 1/4 or 1/8 resolution. Lower resolutions are scaled up to the viewer, either *Sharp* (contrast-adaptive sharpening on the GPU) or *Smooth*.
  - Renders are kept per project, up to 8 GB in all.
- **Preview resolution** in the program monitor: Auto, Full, 1/2, 1/4 or 1/8. Auto steps down while playing when the computer can't keep up.
- **Chats per project.** Start a new chat any time, switch between a project's chats, and rename or delete them. Chats survive restarts, and the model remembers them too, Claude Code and Codex sessions included.
- **See the Copilot think.** Its reasoning streams in live, then folds away under *Thought for 12s*. This works with Claude, OpenAI and Gemini reasoning models, Claude Code and Codex.
- **Copy from chats:** any request, reply, thinking or code block.
- **The web in the Copilot.** It can search the web, read a page, and see a page as a screenshot, and links in its replies show previews.
  - Only public sites are reachable: your network, this computer and cloud metadata addresses are blocked.
  - Pages load in a separate, isolated session.
- **Skills:** know-how the Copilot loads when a task calls for it, in the same SKILL.md format as Claude.
  - Eight are built in: short-form editing, motion design craft, HyperFrames compositions, text behind subject, colour grading, sound and music, Blender 3D, and prompts for generating images, video and voice.
  - Write your own in *Integrations › Skills*, or switch on the ones from Claude Code.
  - The Copilot, Claude Code, Codex and any agent using Lumen's MCP server all get the list and load a skill before that kind of work, Blender scenes and generations included.
- **Motion graphics that look made, not generated.** The templates were redesigned with considered type (Fraunces, Archivo, Syne, Space Grotesk, Instrument Serif), easing that differs per element, and holds long enough to read.
  - Lower thirds, title cards and kinetic type now come in several styles.
  - Two new templates: *Pull quote* and *Chapter marker*.
- **Text behind subject.** Right-click a clip › *Subject*: on-device AI cuts the person out and slips a title between them and the background, in one undo step.
  - The same menu cuts out the subject, removes the background, or removes the person and keeps the background.
  - *Any subject* (objects, animals) uses a GPU model.
  - Each cut-out is made once and reused, and exports are frame-exact.
- **Motion presets** in the Animate tab, baked into keyframes you can then edit. Each comes with an intensity and a curve.
  - Camera moves: Ken Burns, push in, pull out, pans, tilts and drift.
  - Entrances and exits: slide, pop, fade, zoom, drop and spin.
  - Emphasis at the playhead: punch, pulse, shake and wobble.
- **Easing curves per keyframe:** 28 curves (smooth, arrive, leave, overshoot, anticipate, elastic, bounce, hold…) or your own cubic-bezier. Each keyframe's curve shapes the move to the next one.
- **Drag keyframes on the timeline:** the selected clip shows its keyframes. Drag one to retime it, and every property keyed there moves with it. Click one to jump to it.
- **Beat detection.** Right-click a music clip › *Beat* › *Find the beat*. Lumen finds the tempo, beats and bars and marks them on the waveform. Cuts, clips and the playhead then snap to the beat.
  - The same menu adds markers on the downbeats.
  - On video, it lays the selected clips out on the beat.
- **Caption styles.** *Text › Auto captions* has four: *Clean*, *Bold* (big outlined words popping in), *Word by word* (key words in an accent colour) and *Boxed*. One click transcribes what's needed and captions the speech.
- **Select many media files at once:** `Ctrl`-click, `Shift`-click a range, drag a box, or `Ctrl+A`. Then add, favourite, transcribe, make proxies for or remove them together.
- New title fonts: Fraunces, Archivo, Syne and Space Grotesk.
- 11 new AI tools, for 119 in all:
  - `web_search`, `read_web_page` and `screenshot_web_page`;
  - `list_skills`, `use_skill` and `read_skill_file`;
  - `cut_out_subject`, `detect_beats`, `cut_to_beats`, `clip_animate` and `keyframe_move`.
  - `add_captions` also takes a style and an accent colour.

### Changed

- **Smoother on modest computers.**
  - The timeline and preview no longer redraw while nothing changes.
  - Filmstrips and waveforms are painted once and reused.
  - Zooming stretches what's there and repaints when you pause.
  - Scrolling is batched, and scrubbing previews at a lower resolution until you stop.

### Fixed

- HyperFrames motion graphics rendered slightly off-centre when Windows display scaling was above 100% (for example 125%). They're now pixel-exact at any scaling.
- Captions skip silent copies of a clip: detached sound, freeze frames, or volume all the way down. Speech playing on two tracks at once is no longer captioned twice.
- A render or generation that failed straight away could look stuck on *running*, for you and for the Copilot. It now shows its error.

## [1.2.0] — 2026-10-01

Copilot meets your MCP servers.

### Added

- **Copilot uses your MCP servers.** The tools of every connected MCP server are now Copilot tools, and Claude Code and Codex get them too. Each server has a switch for this, on by default. Tools a server marks as destructive ask you first. The integrations screen already promised this; now it's true.
- **GS Cinematic Studio** in the MCP catalogue: direct GTA V cinematics in a FiveM game from the Copilot. You can stage scenes, run the AI Director and Auto-Direct, place cameras, take screenshots and render video, and rendered clips import straight onto the timeline. Connect with the server's address and its `gcs_mcp_token`.

### Changed

- Plain `http://` MCP servers are allowed on your local network (10.x, 172.16–31.x, 192.168.x, Tailscale 100.64/10, `.local`), not only on this computer. Anything on the internet still needs https.

## [1.1.0] — 2026-09-28

The pro update: 27 features that good editors have, and the first version that updates itself.

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
- **Proxies.** Lumen makes a small, quick-seeking 540p copy of 4K footage in the background (or of any video, from its menu in the Media panel), and the preview plays it; exports, frame grabs and the AI always read the original. A button in the preview switches between proxies and originals, and the Lumen menu can turn the automatic proxies off.
- **Long recordings stream.** Audio longer than ten minutes is no longer decoded whole — an hour of stereo is well over a gigabyte once decoded. Playback, export, waveforms, pause detection, transcription and the AI's audio analysis read it a window at a time.
- **Version history** (Lumen menu › *Version history*). Every save is kept, plus a snapshot every ten minutes while you edit — even if you never save. Restore any version (what you had goes into the history first) or open it as a copy. Older versions thin out to one a day, and the history follows the project when its file moves.
- **Collect project** (Lumen menu) copies the project and every media file it uses into one folder, ready to archive or take to another computer.
- The command palette now finds every command that has a keyboard shortcut.
- **Multiple timelines.** A project can hold as many timelines as you like, each with its own size and frame rate — another cut, or a vertical version.
  - A menu at the left of the timeline lists them and makes new ones, including a copy of the whole edit in another shape, reframed to fit.
  - Timelines also appear in the Media panel. Each keeps its own playhead, and undo steps back through switching.
- **Nesting.** Select clips and choose *Nest into a timeline* (`Ctrl+Alt+N`): they move into a timeline of their own, played by one clip you can grade, transform, speed up or cut as a whole.
  - Double-click it to edit inside, with a way back. You can also drag any timeline from the Media panel onto the timeline.
  - The nested timeline's sound plays through, mixed by its own tracks.
  - Nesting main-track clips keeps everything after them in place. *Break apart* brings the contents back.
- **Multicam.** Choose two or more camera recordings (*Make a multicam clip…* in the Media panel or command palette). Lumen lines them up by their sound, to about a millisecond, and keeps one camera's sound.
  - Press `1`–`9` while it plays to cut between cameras at the playhead.
  - Every angle plays live in a strip under the preview; click one to cut to it.
- **Scene detection** splits a clip at every shot change, or marks them, telling cuts from fast motion.
- **Stabilization** measures a clip's camera shake and smooths it away, zooming in just enough to hide the edges. Smoothness, zoom and holding the horizon level are adjustable.
- **Motion tracking.** Box something in the preview and track it forwards, backwards or both ways. A title, sticker or picture-in-picture follows it, or a mask does — so a blurred adjustment layer can hide a moving face.
- **Subtitles.** Import **SRT** and **WebVTT** files as captions (drop them on the timeline, or use the Lumen menu), and export the captions as SRT or WebVTT. The Export dialog can burn captions in, leave them out, and/or save a subtitle file beside the video.
- **Render queue** (`Ctrl+Shift+E`). *Add to queue* in the Export dialog picks the file now; the queue renders its exports one after another while you keep editing, each from the edit as it was when queued. Any timeline can be exported.
- **Transparent exports:** **PNG frames** (a folder of numbered PNGs) and **WebM with an alpha channel** (VP9), for overlays and compositing in other apps.
- 17 new AI tools — `list_timelines`, `import_subtitles`, `export_subtitles`, `detect_scenes`, `create_multicam`, `stabilize_clip`, `track_motion` and `render_queue`, plus the timeline, nesting and multicam commands. `export_video` can export another timeline, PNG frames, transparency and subtitle files, or queue the export. That makes 108 AI tools.

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

[Unreleased]: https://github.com/Mas-inx/lumen-ai-video-editor/compare/v1.5.0...HEAD
[1.5.0]: https://github.com/Mas-inx/lumen-ai-video-editor/releases/tag/v1.5.0
[1.4.0]: https://github.com/Mas-inx/lumen-ai-video-editor/releases/tag/v1.4.0
[1.3.0]: https://github.com/Mas-inx/lumen-ai-video-editor/releases/tag/v1.3.0
[1.2.0]: https://github.com/Mas-inx/lumen-ai-video-editor/releases/tag/v1.2.0
[1.1.0]: https://github.com/Mas-inx/lumen-ai-video-editor/releases/tag/v1.1.0
[1.0.2]: https://github.com/Mas-inx/lumen-ai-video-editor/releases/tag/v1.0.2
[1.0.1]: https://github.com/Mas-inx/lumen-ai-video-editor/releases/tag/v1.0.1
[1.0.0]: https://github.com/Mas-inx/lumen-ai-video-editor/releases/tag/v1.0.0
