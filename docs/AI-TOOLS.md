# Lumen AI tools

Every AI that works in Lumen — the Copilot's API models, your own Claude Code or Codex, and any agent connected to Lumen's MCP server — uses this same set of **69 tools**. This page is generated from the tool registry ([`src/integrations/agent-tools.ts`](../src/integrations/agent-tools.ts) and [`src/integrations/tools/`](../src/integrations/tools)).

- **Times:** the helper tools take seconds; editor commands take integer frames at the project's fps (see `get_project`).
- **Pictures:** `get_frame`, `get_contact_sheet`, `get_media_frames` and `get_editor_screenshot` return an image block along with JSON — over MCP as `image` content, and to the Copilot's models as real images.
- **Undo:** every edit is a normal undo step, marked as made by the AI in History. `batch_edit` makes several edits one step that applies completely or not at all.
- **Safety:** tools that run code (Blender scripts) wait for the user's approval; exports and saves go where the user chooses.

## Contents

- [See](#see) — 4 tools
- [Hear and read](#hear-and-read) — 8 tools
- [Act](#act) — 10 tools
- [Smart edits](#smart-edits) — 6 tools
- [Generate and import](#generate-and-import) — 16 tools
- [Editor commands](#editor-commands) — 25 tools

## See

Pictures of the edit, rendered exactly as the export will look, and of the editor itself.

### `get_frame`

See the video. Renders the timeline at one moment exactly as the export will look — every track, effect, title and transition — and returns it as an image, with the clips on screen (top layer first). Defaults to the playhead. Use it to check framing, text and looks, and to verify visual edits after making them.

| Parameter | Type | Description |
| --- | --- | --- |
| `time_seconds` | number | Timeline time in seconds (default: the playhead) |
| `frame` | integer | Timeline frame, instead of time_seconds |
| `width` | number | Image width in pixels (256–1920, default 1024). Wider shows more detail but costs more tokens. |

### `get_contact_sheet`

Watch the whole edit — or a stretch of it — at a glance: evenly spaced frames laid out in one labelled grid image (each cell shows its number and time). Far cheaper than many get_frame calls: use it to understand a video before editing and to review the result afterwards.

| Parameter | Type | Description |
| --- | --- | --- |
| `count` | integer | How many frames (4–36, default 12) |
| `from_seconds` | number | Start of the stretch (default 0) |
| `to_seconds` | number | End of the stretch (default: the end of the timeline) |

### `get_media_frames`

Look inside a media file from the library before using it: frames of a video (evenly spaced, or at given source times) as one labelled image, or the picture itself for an image. Use it to pick the right shot or moment, e.g. before place_asset or clip_trim.

| Parameter | Type | Description |
| --- | --- | --- |
| `asset_id` **(required)** | string | Media id (from get_project or find_media) |
| `count` | integer | Evenly spaced frames to show (1–24, default 8). Ignored when times_seconds is given. |
| `times_seconds` | number[] | Exact source times to show, in seconds |
| `width` | number | Image width in pixels (256–1920, default 1024). Wider shows more detail but costs more tokens. |

### `get_editor_screenshot`

A screenshot of Lumen’s own window — the editor as the user sees it right now: timeline, panels, inspector, open dialogs. Use it when the user points at something on screen or to check the UI state; for the video itself use get_frame.

| Parameter | Type | Description |
| --- | --- | --- |
| `width` | number | Image width in pixels (640–2560, default 1600) |

## Hear and read

What’s said, how it sounds, and everything about the project.

### `get_project`

Everything about the open project: settings (fps!), tracks with their clips (frames), media library, markers, playhead and selection. Call this before editing.

_No parameters._

### `get_clips_at`

Everything under one moment of the timeline, on every track (top layer first): each clip’s times, the source time it shows, and its transform and volume at that exact frame with keyframes applied. Pairs with get_frame. Defaults to the playhead.

| Parameter | Type | Description |
| --- | --- | --- |
| `time_seconds` | number | Timeline time in seconds (default: the playhead) |
| `frame` | integer | Timeline frame, instead of time_seconds |

### `get_clip`

Full details of one or more clips — every property (transform, color grade, audio mix, keyframes, effects, animation, transition, text style, speed, look, blend), with times in seconds and the media each uses. Read a clip before a precise edit so you only change what you mean to.

| Parameter | Type | Description |
| --- | --- | --- |
| `clip_ids` **(required)** | string[] | Clip ids |

### `find_media`

Search the media library by name, tag or kind — and, for transcribed media, by what is said in it (returns the matching lines with their source times, ready for place_asset or clip_trim). Lists length, size, frame rate, audio, transcript, tags and how often each item is used on the timeline.

| Parameter | Type | Description |
| --- | --- | --- |
| `query` | string | Words to look for in names, tags, file paths and transcripts |
| `kind` | `video` · `audio` · `image` | Only this kind |
| `tag` | string | Only media with this tag |
| `unused` | boolean | Only media not on the timeline yet |
| `limit` | integer | Most results to return (default 50) |

### `get_transcript`

What is said, and when. With asset_id: that media file’s transcript in source seconds. Without: everything said on the timeline in timeline seconds, after every cut (lines a cut runs through are marked partial). If something isn’t transcribed yet, call transcribe_media first.

| Parameter | Type | Description |
| --- | --- | --- |
| `asset_id` | string | A media id — omit for the timeline |
| `from_seconds` | number | Only from this time |
| `to_seconds` | number | Only up to this time |

### `analyze_audio`

Hear the sound. Loudness in LUFS (as YouTube and Spotify measure it), the loudest 3 seconds, peak level, clipping, where there is sound and where there is silence, plus plain-language advice — for one media file (asset_id) or for the timeline mix (optionally a stretch, optionally per track to compare voice and music).

| Parameter | Type | Description |
| --- | --- | --- |
| `asset_id` | string | A media id — omit to analyze the timeline mix |
| `from_seconds` | number | Start of the stretch |
| `to_seconds` | number | End of the stretch |
| `per_track` | boolean | Timeline only: also measure each track on its own |

### `get_history`

Recent undo steps, newest first: what each did, who made it (user or ai) and how long ago. Check it before undo, or to see what changed since you last looked.

| Parameter | Type | Description |
| --- | --- | --- |
| `limit` | integer | How many steps (default 20) |

### `list_catalog`

The exact ids Lumen’s editing commands accept, with names and descriptions: effects, transitions, looks (color presets), title presets, text animations, fonts, blend modes, easings, built-in sound effects and canvas presets. Use it instead of guessing ids.

| Parameter | Type | Description |
| --- | --- | --- |
| `section` | `effects` · `transitions` · `looks` · `titles` · `animations` · `fonts` · `blend_modes` · `easings` · `sound_effects` · `canvas_presets` | Just one section (default: everything) |

## Act

Editing helpers that take seconds instead of frames, all-or-nothing batches, and control of the editor.

### `batch_edit`

Run several editing commands as ONE undo step. atomic (default true): if any command fails, everything is rolled back and nothing changes — so a multi-step edit never lands half-done. Each item is { command, input } where command is a command tool name (e.g. "clip_update" or "clip.update") and input is exactly what that tool takes. To refer to something created earlier in the batch, give it an id yourself (clip_add and track_add accept id).

| Parameter | Type | Description |
| --- | --- | --- |
| `commands` **(required)** | object[] | The commands, in order |
| `label` | string | What the History shows for this step |
| `atomic` | boolean | All or nothing (default true) |

### `add_title`

Add a text title in one step, styled from a title preset (see list_catalog → titles) and scaled to the canvas: on the titles track at a time in seconds, for a duration. Returns the clip id — fine-tune it with clip_update. For captions of speech use add_captions.

| Parameter | Type | Description |
| --- | --- | --- |
| `text` **(required)** | string | The words |
| `at_seconds` | number | When it appears (default: the playhead) |
| `duration_seconds` | number | How long it stays (default: the preset’s length) |
| `preset` | `cinematic` · `elegant` · `headline` · `lower-third` · `subtitle` · `neon` · `handwritten` · `3d-chrome` · `3d-gold` · `3d-block` · `chapter` | Style (default headline) |
| `position` | `top` · `center` · `bottom` · `lower-third` | Where on screen (default center) |
| `size` | number | Text size in project pixels (default: the preset’s, scaled to the canvas) |
| `color` | string | Text color, e.g. #ffffff |
| `track_id` | string | Use this video track instead of the titles track |

### `place_asset`

Put a media item (from get_project → media) on the timeline. Footage goes on the main story track; transparent overlays go on a track above.

| Parameter | Type | Description |
| --- | --- | --- |
| `asset_id` **(required)** | string | Media id |
| `at_seconds` | number | Where to place it, in seconds from the start of the timeline (default: the playhead). |
| `track_id` | string | Optional track to use |

### `seek`

Move the playhead (what the user sees in the viewer).

| Parameter | Type | Description |
| --- | --- | --- |
| `seconds` **(required)** | number | Time in seconds |

### `select_clips`

Select clips in the timeline so the user sees what you mean (the Inspector shows them). reveal also moves the playhead to the first one. An empty list clears the selection.

| Parameter | Type | Description |
| --- | --- | --- |
| `clip_ids` **(required)** | string[] | Clip ids (empty to clear) |
| `reveal` | boolean | Move the playhead to the first selected clip |

### `playback`

Play or pause the preview for the user, optionally from a time. (To look at the video yourself, use get_frame or get_contact_sheet.)

| Parameter | Type | Description |
| --- | --- | --- |
| `action` **(required)** | `play` · `pause` | What to do |
| `from_seconds` | number | Start playing from here |

### `undo`

Undo the most recent edits (one or more steps). Only undo your own work unless the user asks — check get_history first.

| Parameter | Type | Description |
| --- | --- | --- |
| `steps` | integer | How many steps (1–20, default 1) |

### `redo`

Redo edits that were just undone.

| Parameter | Type | Description |
| --- | --- | --- |
| `steps` | integer | How many steps (1–20, default 1) |

### `save_project`

Save the project file. If it has never been saved — or as_new_file is true — the user picks where in a Save dialog.

| Parameter | Type | Description |
| --- | --- | --- |
| `as_new_file` | boolean | Save a copy under a new name / location |

### `export_video`

Export the edit to a video (or audio) file. The user chooses where to save it in a Save dialog — nothing is written without them — and sees progress with a Cancel button. Waits for the export and returns the file path. Renders the whole timeline unless from_seconds / to_seconds are given.

| Parameter | Type | Description |
| --- | --- | --- |
| `format` | `mp4` · `mov` · `webm` · `gif` · `wav` · `m4a` | File type (default mp4) |
| `resolution` | `2160` · `1440` · `1080` · `720` · `480` | Output size by its short side (default: the project’s own size) |
| `fps` | `24` · `25` · `30` · `50` · `60` | Frame rate (default: the project’s) |
| `quality` | integer | 10–100 (default 72; 85+ is master quality) |
| `codec` | `avc` · `hevc` · `av1` · `vp9` | Video codec (default: the best this machine encodes for the format) |
| `from_seconds` | number | Start of the part to export |
| `to_seconds` | number | End of the part to export |
| `file_name` | string | Suggested file name (default: the project name) |

## Smart edits

Multi-step edits driven by the actual speech and sound.

### `transcribe_media`

Transcribe an audio or video asset and attach the timed transcript to it (powers captions, pause removal and ducking). Uses ElevenLabs or OpenAI when connected, otherwise Whisper on this computer.

| Parameter | Type | Description |
| --- | --- | --- |
| `asset_id` **(required)** | string | Media id from get_project |
| `language_code` | string | Optional ISO language code, e.g. "en" |
| `provider` | `elevenlabs` · `openai` · `local` | Optional: which service |

### `find_pauses`

Measure the long pauses in the speech on the timeline (from the audio itself, or transcripts). Returns the timeline spans remove_pauses would cut, in seconds (only where every speaker is quiet), and which clips were analysed.

| Parameter | Type | Description |
| --- | --- | --- |
| `clip_ids` | string[] | Only these clips (default: every clip with speech) |
| `min_gap_seconds` | number | Shortest pause to report (default 0.6) |

### `remove_pauses`

Cut long pauses out of the speech (keeping a little breath around each line). The whole timeline closes up around each cut, so captions, B-roll, effects and markers stay in sync; music beds play on through the joins. Only cuts where every speaker is quiet. One undo step.

| Parameter | Type | Description |
| --- | --- | --- |
| `clip_ids` | string[] | Only these clips (default: every clip with speech) |
| `min_gap_seconds` | number | Shortest pause to cut (default 0.6) |

### `add_captions`

Caption all the speech on the timeline: transcribes any speech media that has no transcript yet, then lays timed captions on a Captions track (replacing earlier captions).

| Parameter | Type | Description |
| --- | --- | --- |
| `max_words` | number | Words per caption (default 6) |
| `size` | number | Text size in project pixels (default: 4.5% of the frame) |
| `uppercase` | boolean | ALL CAPS captions |

### `duck_music`

Lower music clips under speech with volume keyframes (short ramps, merged phrases). Finds the music and speech clips itself unless you pass ids.

| Parameter | Type | Description |
| --- | --- | --- |
| `depth_db` | number | How far to dip, in dB (default 10) |
| `music_clip_ids` | string[] |  |
| `voice_clip_ids` | string[] |  |

### `reframe`

Change the canvas size (e.g. 1080x1920 for vertical) and reframe: footage that filled the old frame is scaled to fill the new one, titles are moved and resized to match.

| Parameter | Type | Description |
| --- | --- | --- |
| `width` **(required)** | number | Canvas width in pixels |
| `height` **(required)** | number | Canvas height in pixels |

## Generate and import

New media from Blender, HyperFrames, OpenAI, Gemini and ElevenLabs, or from files and links.

### `render_3d_title`

Render a real 3D title in Blender (extruded, bevelled, studio-lit, motion-blurred, transparent background) and add it to the project. Needs Blender installed.

| Parameter | Type | Description |
| --- | --- | --- |
| `text` **(required)** | string | The title text |
| `material` | `chrome` · `gold` · `glass` · `plastic` · `neon` · `clay` · `matte` | Surface |
| `color` | string | Hex colour for plastic / neon / clay / matte, e.g. #ff5a36 |
| `font` | `sans` · `display` · `serif` · `serif-italic` | Typeface |
| `motion` | `spin` · `rise` · `slam` · `orbit` · `float` | Intro move |
| `depth` | number | Extrusion depth 0–1 (default 0.35) |
| `duration_seconds` | number | Clip length (default 4) |
| `quality` | `draft` · `standard` · `high` | Render quality |
| `place` | boolean | Put the finished clip on the timeline at the playhead (default true). |
| `at_seconds` | number | Where to place it, in seconds from the start of the timeline (default: the playhead). |
| `wait_seconds` | number | Seconds to wait for the render before returning (default 90, max 600). If it is still running, poll get_job. |

### `render_3d_background`

Render a seamless-looping abstract 3D background in Blender (glossy forms, depth of field) and add it to the project.

| Parameter | Type | Description |
| --- | --- | --- |
| `palette` | `aurora` · `sunset` · `candy` · `ocean` · `mono` | Colours |
| `style` | `mix` · `blobs` · `rings` · `cubes` | Shapes |
| `background` | string | Hex background colour (default near-black) |
| `speed` | number | Loops per clip, 1–3 (default 1) |
| `duration_seconds` | number | Clip length (default 8) |
| `quality` | `draft` · `standard` · `high` | Render quality |
| `place` | boolean | Put the finished clip on the timeline at the playhead (default true). |
| `at_seconds` | number | Where to place it, in seconds from the start of the timeline (default: the playhead). |
| `wait_seconds` | number | Seconds to wait for the render before returning (default 90, max 600). If it is still running, poll get_job. |

### `render_blender_script`

Render any Blender scene you write in Python (bpy) and add it to the project. The script runs once on an empty scene at the project's size and fps; build objects, materials, lights and camera. Define animate(t, frame) to animate per frame (t in seconds), or insert keyframes yourself. Helpers in scope: scene, P, W, H, FPS, FRAMES, DURATION, hex_color, principled(name, color, metallic, roughness, coat, emission, strength, transmission), material_preset('chrome'|'gold'|'glass'|'neon'|'plastic', hex), studio_world(), add_camera(location, target, lens), add_light(kind, location, energy, size), look_at(obj, target), load_font('sans'|'display'|'serif'), ease_out_cubic, ease_in_out, ease_out_back, lerp. The user must approve the script in Lumen before it runs.

| Parameter | Type | Description |
| --- | --- | --- |
| `script` **(required)** | string | Python (bpy) source |
| `description` **(required)** | string | One line telling the user what the scene is |
| `duration_seconds` | number | Clip length (default 4) |
| `transparent` | boolean | Transparent background (default true) |
| `quality` | `draft` · `standard` · `high` | Render quality |
| `place` | boolean | Put the finished clip on the timeline at the playhead (default true). |
| `at_seconds` | number | Where to place it, in seconds from the start of the timeline (default: the playhead). |
| `wait_seconds` | number | Seconds to wait for the render before returning (default 90, max 600). If it is still running, poll get_job. |

### `blender_live`

Run bpy code inside the Blender window the user has open (needs the BlenderMCP add-on listening on port 9876). Use for inspecting or changing their scene. The user must approve it in Lumen.

| Parameter | Type | Description |
| --- | --- | --- |
| `code` **(required)** | string | Python (bpy) source |
| `description` **(required)** | string | One line telling the user what it does |

### `render_motion_graphic`

Render a HyperFrames motion graphic from a template and add it to the project (transparent). Templates and params — lower-third: { name, title, accent, accent2, align: "left"|"right", font }; title-card: { title, subtitle, eyebrow, accent, color, font: "sans"|"display"|"serif" }; kinetic: { text, style: "punch"|"stack", accent, color, font } (wrap words in *stars* to highlight); counter: { value, prefix, suffix, decimals, label, accent, accent2 }.

| Parameter | Type | Description |
| --- | --- | --- |
| `template` **(required)** | `lower-third` · `title-card` · `kinetic` · `counter` | Template |
| `params` **(required)** | object | Template parameters (see description) |
| `duration_seconds` | number | Clip length (defaults: lower third 5, others 4) |
| `place` | boolean | Put the finished clip on the timeline at the playhead (default true). |
| `at_seconds` | number | Where to place it, in seconds from the start of the timeline (default: the playhead). |
| `wait_seconds` | number | Seconds to wait for the render before returning (default 90, max 600). If it is still running, poll get_job. |

### `render_hyperframes_html`

Render your own HyperFrames composition (HTML + CSS + GSAP) to a transparent clip and add it to the project. Requirements: a <meta data-composition-id="ID" data-width data-height>, timed elements with class="clip" data-start data-duration data-track-index, and a paused GSAP timeline registered as window.__timelines["ID"]. Load GSAP from cdn.jsdelivr.net (Lumen swaps in a local copy). Keep html/body background transparent for overlays; size the page to the project (see get_project settings).

| Parameter | Type | Description |
| --- | --- | --- |
| `html` **(required)** | string | The complete HTML document |
| `name` **(required)** | string | Clip name |
| `duration_seconds` | number | Length to render (default: the composition’s own duration) |
| `place` | boolean | Put the finished clip on the timeline at the playhead (default true). |
| `at_seconds` | number | Where to place it, in seconds from the start of the timeline (default: the playhead). |
| `wait_seconds` | number | Seconds to wait for the render before returning (default 90, max 600). If it is still running, poll get_job. |

### `generate_image`

Generate an image with the user’s OpenAI (GPT Image) or Google (Gemini image) key and add it to the project.

| Parameter | Type | Description |
| --- | --- | --- |
| `prompt` **(required)** | string | What the image should show |
| `provider` | `openai` · `gemini` | Which service (default: whichever is connected) |
| `model` | string | Optional model id |
| `aspect` | `16:9` · `9:16` · `1:1` | Shape (default: the project’s) |
| `place` | boolean | Put the finished clip on the timeline at the playhead (default true). |
| `at_seconds` | number | Where to place it, in seconds from the start of the timeline (default: the playhead). |
| `wait_seconds` | number | Seconds to wait for the render before returning (default 90, max 600). If it is still running, poll get_job. |

### `generate_video`

Generate a video clip with the user’s OpenAI or Google (Veo) key — whichever video models their key can use — and add it to the project. Takes a minute or more — returns the job; it lands on the timeline when done.

| Parameter | Type | Description |
| --- | --- | --- |
| `prompt` **(required)** | string | Describe the shot: subject, action, camera, light |
| `provider` | `openai` · `gemini` | Which service (default: whichever is connected) |
| `model` | string | Optional model id |
| `aspect` | `16:9` · `9:16` | Shape (default: the project’s) |
| `seconds` | number | Length in seconds (each model allows a few lengths, e.g. Veo: 4, 6 or 8) |
| `place` | boolean | Put the finished clip on the timeline at the playhead (default true). |
| `at_seconds` | number | Where to place it, in seconds from the start of the timeline (default: the playhead). |
| `wait_seconds` | number | Seconds to wait for the render before returning (default 90, max 600). If it is still running, poll get_job. |

### `list_voices`

ElevenLabs voices on the user’s account (needs ElevenLabs connected in Lumen).

| Parameter | Type | Description |
| --- | --- | --- |
| `search` | string | Optional filter, e.g. "british" or "narrator" |

### `generate_voiceover`

Speak text with an ElevenLabs voice and add it to the project. It comes with a transcript, so add_captions-style edits and pause removal work on it. Places it on the timeline by default.

| Parameter | Type | Description |
| --- | --- | --- |
| `text` **(required)** | string | What to say |
| `voice_id` | string | From list_voices (default: the first voice) |
| `model` | `eleven_multilingual_v2` · `eleven_flash_v2_5` | Voice model |
| `place` | boolean | Put the finished clip on the timeline at the playhead (default true). |
| `at_seconds` | number | Where to place it, in seconds from the start of the timeline (default: the playhead). |
| `wait_seconds` | number | Seconds to wait for the render before returning (default 90, max 600). If it is still running, poll get_job. |

### `generate_sound_effect`

Generate a sound effect with ElevenLabs from a description (up to 30 s) and add it to the project.

| Parameter | Type | Description |
| --- | --- | --- |
| `prompt` **(required)** | string | Describe the sound |
| `duration_seconds` | number | 0.5–30 (default: automatic) |
| `loop` | boolean | Seamless loop |
| `place` | boolean | Put the finished clip on the timeline at the playhead (default true). |
| `at_seconds` | number | Where to place it, in seconds from the start of the timeline (default: the playhead). |
| `wait_seconds` | number | Seconds to wait for the render before returning (default 90, max 600). If it is still running, poll get_job. |

### `generate_music`

Compose music with ElevenLabs from a prompt and add it to the project (paid ElevenLabs plans).

| Parameter | Type | Description |
| --- | --- | --- |
| `prompt` **(required)** | string | Genre, mood, instruments, structure |
| `length_seconds` | number | 3–600 (default 30) |
| `instrumental` | boolean | No vocals (default true) |
| `place` | boolean | Put the finished clip on the timeline at the playhead (default true). |
| `at_seconds` | number | Where to place it, in seconds from the start of the timeline (default: the playhead). |
| `wait_seconds` | number | Seconds to wait for the render before returning (default 90, max 600). If it is still running, poll get_job. |

### `add_sound_effect`

Add one of Lumen’s built-in sound effects at a time on the timeline. Available: whoosh (Fast air sweep for cuts), swoosh (Slow, airy pass-by), riser (Tension build into a drop), impact (Deep boom with a tail), hit (Tight, punchy accent), heartbeat (Lub-dub, for suspense), pop (Bubbly pop for text and stickers), click (Crisp interface click), ding (Clear bell for reveals), success (Rising three-note chime), notify (Two-tone message ping), shutter (Mechanical snap for photos), glitch (Digital stutter for tech edits), drone (Dark bed for suspense (loops)), wind (Outdoor wind bed (loops)).

| Parameter | Type | Description |
| --- | --- | --- |
| `sfx_id` **(required)** | `whoosh` · `swoosh` · `riser` · `impact` · `hit` · `heartbeat` · `pop` · `click` · `ding` · `success` · `notify` · `shutter` · `glitch` · `drone` · `wind` | Which effect |
| `at_seconds` | number | Where to place it, in seconds from the start of the timeline (default: the playhead). |

### `import_media_file`

Import video, audio or image files from this computer into the project by path (folders import every media file inside). Optionally place them on the timeline one after another.

| Parameter | Type | Description |
| --- | --- | --- |
| `paths` **(required)** | string[] | Absolute file or folder paths |
| `place` | boolean | Also put them on the timeline at the playhead (default false) |
| `at_seconds` | number | Where to place it, in seconds from the start of the timeline (default: the playhead). |

### `import_media_url`

Download an image, video or audio file from a URL (e.g. a generation result) into the project’s media, optionally placing it.

| Parameter | Type | Description |
| --- | --- | --- |
| `url` **(required)** | string | https:// URL of the file |
| `name` | string | Media name |
| `place` | boolean | Also put it on the timeline at the playhead (default false) |
| `at_seconds` | number | Where to place it, in seconds from the start of the timeline (default: the playhead). |

### `get_job`

Status of a render or generation job. Waits up to wait_seconds for it to finish.

| Parameter | Type | Description |
| --- | --- | --- |
| `job_id` **(required)** | string | Job id |
| `wait_seconds` | number | Seconds to wait for the render before returning (default 90, max 600). If it is still running, poll get_job. |

## Editor commands

Every edit the UI can make, as a typed command: undoable, in the History, frames at the project’s fps. Generated from the command registry.

### `clip_add`

Add a clip to a track. Media clips (video/image/audio) reference an asset; text clips take a text style via patch.text; adjustment clips grade everything beneath them. Overlapping positions slide to the nearest free spot. Returns the new clip id.

| Parameter | Type | Description |
| --- | --- | --- |
| `id` | string |  |
| `trackId` **(required)** | string |  |
| `kind` **(required)** | `video` · `image` · `audio` · `text` · `adjustment` |  |
| `start` **(required)** | integer | (≥ 0) |
| `duration` **(required)** | integer | (≥ 1) |
| `assetId` | string |  |
| `inPoint` | integer | (≥ 0) |
| `name` | string |  |
| `patch` | object |  |

### `clip_move`

Move one or more clips to new start frames and optionally other tracks. Moves are applied as a group; if they would overlap other clips the group slides to the nearest place that fits.

| Parameter | Type | Description |
| --- | --- | --- |
| `moves` **(required)** | object[] |  |

### `clip_trim`

Trim a clip by moving its start or end edge to an absolute timeline frame. Respects the source media length and neighbouring clips.

| Parameter | Type | Description |
| --- | --- | --- |
| `id` **(required)** | string |  |
| `edge` **(required)** | `start` · `end` |  |
| `frame` **(required)** | integer | (≥ 0) |

### `clip_split`

Split clips at a timeline frame. With ids, splits only those clips; otherwise splits every clip under the frame on unlocked tracks. Returns the ids of the new right-hand clips.

| Parameter | Type | Description |
| --- | --- | --- |
| `frame` **(required)** | integer | (≥ 0) |
| `ids` | string[] |  |

### `clip_delete`

Delete clips. With ripple, later clips on the same track shift left to close the gap.

| Parameter | Type | Description |
| --- | --- | --- |
| `ids` **(required)** | string[] |  |
| `ripple` **(required)** | boolean | Default `false`. |

### `timeline_removeRange`

Take a stretch of time out of the whole timeline (like Extract): clips inside it are removed, clips across it lose that stretch, and everything later — on every unlocked track, plus markers — moves left to close up. Clips listed in keepWhole (music beds, ambience) are not cut: they keep playing through the join and end earlier.

| Parameter | Type | Description |
| --- | --- | --- |
| `start` **(required)** | integer | (≥ 0) |
| `end` **(required)** | integer | (≥ 0) |
| `keepWhole` **(required)** | string[] | Default `[]`. |

### `clip_update`

Update clip properties: name, speed, reverse, blend mode, transform (x, y, scale, rotation, opacity), color grade, audio mix, text style, in/out animations or look. Applies the same patch to every id.

| Parameter | Type | Description |
| --- | --- | --- |
| `ids` **(required)** | string[] |  |
| `patch` **(required)** | object |  |

### `clip_duplicate`

Duplicate clips; each copy is placed right after its original on the same track. Returns the new ids.

| Parameter | Type | Description |
| --- | --- | --- |
| `ids` **(required)** | string[] |  |

### `clip_setTransition`

Set or clear the transition that plays from the previous clip into this one. Durations are in frames.

| Parameter | Type | Description |
| --- | --- | --- |
| `id` **(required)** | string |  |
| `transition` **(required)** | object or null |  |

### `effect_add`

Add an effect to clips (or update its amount if already present). Amount is 0–100.

| Parameter | Type | Description |
| --- | --- | --- |
| `ids` **(required)** | string[] |  |
| `kind` **(required)** | `blur` · `glow` · `vignette` · `grain` · `mono` · `shake` · `pulse` · `leak` · `rgb` · `sharpen` · `tilt3d` · `curve3d` · `wave3d` · `cube3d` · `mirror3d` |  |
| `amount` | number | (≥ 0, ≤ 100) |

### `effect_update`

Turn an effect on or off, or change its amount (0–100). Effect ids are in get_clip → effects.

| Parameter | Type | Description |
| --- | --- | --- |
| `clipId` **(required)** | string |  |
| `effectId` **(required)** | string |  |
| `patch` **(required)** | object |  |

### `effect_remove`

Remove an effect from a clip. Effect ids are in get_clip → effects.

| Parameter | Type | Description |
| --- | --- | --- |
| `clipId` **(required)** | string |  |
| `effectId` **(required)** | string |  |

### `keyframe_set`

Set a keyframe on an animatable property (x, y, scale, rotation, opacity, volume) at a frame relative to the clip start.

| Parameter | Type | Description |
| --- | --- | --- |
| `clipId` **(required)** | string |  |
| `prop` **(required)** | `x` · `y` · `scale` · `rotation` · `opacity` · `volume` · `rotateX` · `rotateY` · `z` |  |
| `frame` **(required)** | integer | (≥ 0) |
| `value` **(required)** | number |  |
| `easing` | `linear` · `ease` · `ease-in` · `ease-out` · `hold` |  |

### `keyframe_remove`

Remove the keyframe at a clip-relative frame.

| Parameter | Type | Description |
| --- | --- | --- |
| `clipId` **(required)** | string |  |
| `prop` **(required)** | `x` · `y` · `scale` · `rotation` · `opacity` · `volume` · `rotateX` · `rotateY` · `z` |  |
| `frame` **(required)** | integer | (≥ 0) |

### `keyframe_clear`

Remove all keyframes from a property, keeping its first value.

| Parameter | Type | Description |
| --- | --- | --- |
| `clipId` **(required)** | string |  |
| `prop` **(required)** | `x` · `y` · `scale` · `rotation` · `opacity` · `volume` · `rotateX` · `rotateY` · `z` |  |

### `track_add`

Add a video or audio track. Video tracks go on top by default, audio tracks at the bottom. Returns the id.

| Parameter | Type | Description |
| --- | --- | --- |
| `id` | string |  |
| `kind` **(required)** | `video` · `audio` |  |
| `name` | string |  |
| `index` | integer | (≥ 0) |
| `role` | `main` · `titles` · `captions` |  |

### `track_update`

Rename a track, or toggle hidden / muted / locked, or change its height.

| Parameter | Type | Description |
| --- | --- | --- |
| `id` **(required)** | string |  |
| `patch` **(required)** | object |  |

### `track_remove`

Remove a track and every clip on it (track ids are in get_project → tracks).

| Parameter | Type | Description |
| --- | --- | --- |
| `id` **(required)** | string |  |

### `marker_add`

Drop a marker on the timeline ruler. Returns the id.

| Parameter | Type | Description |
| --- | --- | --- |
| `id` | string |  |
| `frame` **(required)** | integer | (≥ 0) |
| `label` | string |  |
| `color` | `lime` · `violet` · `pink` · `amber` · `emerald` · `sky` |  |

### `marker_update`

Move, rename or recolor a marker (marker ids are in get_project → markers).

| Parameter | Type | Description |
| --- | --- | --- |
| `id` **(required)** | string |  |
| `patch` **(required)** | object |  |

### `marker_remove`

Remove a marker (marker ids are in get_project → markers).

| Parameter | Type | Description |
| --- | --- | --- |
| `id` **(required)** | string |  |

### `asset_add`

Register a media asset in the project library.

| Parameter | Type | Description |
| --- | --- | --- |
| `asset` **(required)** | object |  |

### `asset_update`

Rename or favorite an asset, attach its transcript (timed phrases in seconds), or point it at a new file (relink: source, duration, size, audio).

| Parameter | Type | Description |
| --- | --- | --- |
| `id` **(required)** | string |  |
| `patch` **(required)** | object |  |

### `asset_remove`

Remove assets from the library, along with every clip that uses them.

| Parameter | Type | Description |
| --- | --- | --- |
| `ids` **(required)** | string[] |  |

### `project_update`

Rename the project or change its settings (width, height, fps, background color). Changing fps re-times every clip so nothing drifts.

| Parameter | Type | Description |
| --- | --- | --- |
| `name` | string |  |
| `settings` | object |  |

---

Connect an agent: turn on **Integrations › Lumen MCP server**, then for Claude Code:

```bash
claude mcp add --transport http lumen http://127.0.0.1:47910/mcp --header "Authorization: Bearer <token from Lumen>"
```
