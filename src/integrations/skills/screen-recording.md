---
name: screen-recording
description: Use when recording a screen, a window or a game with Lumen and cutting the result — demos, tutorials, gameplay, or filming a GS Cinematic Studio take live.
---

# Screen recording

Lumen records a screen or a window straight into the project, then you cut it like any other clip. You drive it with `list_capture_sources`, `start_recording`, `recording_status`, `add_recording_marker`, `pause_recording` and `stop_recording`. The first call asks the user to allow screen recording for this session; if they decline, stop and say so.

## Choosing what to record

- **Find it first.** `list_capture_sources` gives every screen and window with its app's file name and a numbered picture. Pass the id as `source`, or words from the title or app (`"fivem"`, `"chrome"`, `"screen"`).
- **A window over a screen** whenever the subject is one app: nothing else gets in, it can be moved without spoiling the take, and `audio: "app"` records only that app's sound.
- **A minimized window has nothing to record.** Ask the user to bring it back.
- **Part of a source:** `region: { x, y, width, height }` in the source's pixels.

## Settings that matter

| Goal | Settings |
| --- | --- |
| Software demo or tutorial | `resolution: "native"`, `fps: 30` or `60`, `cursor: true`, `click_data: true`, `audio: "app"` or `"off"`, `microphone: true` if they will narrate |
| Gameplay or a film take | `fps: 60`, `cursor: false`, `click_data: false`, `audio: "app"`, `quality: 80` |
| Something to share small | `resolution: "1080p"`, `codec: "hevc"` or `"av1"` |

- **Resolution** names the short side and keeps the source's shape. `"4k"` on a smaller source scales it up while recording, which costs processor time: on a laptop's built-in graphics it may not hold 60. If `recording_status` reports `frames_skipped` climbing, or `source_fps` well under what you asked for, record at `"native"` and export at 4K instead.
- **The encoder is chosen for you.** The graphics card's is tried with real frames first, then another codec on the card, then the processor. The answer says which is in use.
- **Sound.** `"app"` is one app's sound (windows only, Windows 11 or recent Windows 10); `"system"` is everything the computer plays, Lumen included; the microphone and the camera are always clips of their own.

## While it runs

- Do the thing being recorded between `start_recording` and `stop_recording`. For a fixed length, pass `max_seconds` and wait with `recording_status({ wait_seconds })`.
- `add_recording_marker({ label })` at each moment worth finding later. Markers become cues on the clip; `get_clip` lists them at timeline seconds.
- `pause_recording` leaves the paused time out of the file.

## After it stops

`stop_recording` returns the clips. The recording goes on the main track, the camera in the corner above it, the microphone on a voice track, all lined up and grouped. An empty timeline takes the recording's size and frame rate.

Then edit:

1. `get_clip` for the cues (markers) and clicks.
2. Trim the start and end, and cut waits: `find_pauses` / `remove_pauses` when there is narration; otherwise cut between the markers or where the clicks stop for long.
3. **`zoom_on_clicks`** pushes in on each click and eases back out. Defaults suit a demo: zoom 2, hold 1.6 s. Use `zoom: 1.5` for dense screens and `group_seconds: 4` to stay in while several clicks happen nearby.
4. **`highlight_clicks`** after the zooms (it follows them) for a pulse on each click.
5. `transcribe_media` and `add_captions` for narration; `duck_music` if you add music.
6. Check a frame with `get_frame` at a zoomed moment before you say it is done.

## Filming a GS Cinematic Studio take

`record_studio_take` does the whole thing: it finds the game's window, starts recording (picture and only the game's sound, no pointer), has the studio play the take with every panel hidden, stops, and puts the clip on the timeline trimmed to exactly the take, with the studio's cue sheet attached.

- **It needs** the studio connected in Integrations with a director's game under remote control (`/studio_remote on`), the studio open with a project (`open_studio`, `open_project`), and the game in a window or borderless on this computer.
- **Choose the take** with `target`: `scene`, `shot` (with `path_id`) or `range` (`from_frame`, `to_frame`).
- **When to use the other way.** A recorded take moves and sounds as the game does, at the frame rate the game holds. `render_export` with `ingest_start` is frame-exact at any resolution but silent and slower; use it for final shots the game can't play smoothly.
- **If the take comes back frozen or silent**, the game paused when it lost focus: have the user turn off "Pause game on focus loss" in its settings.
- After the take: `get_clip` gives the cues (lines, cuts, footsteps) at timeline seconds, ready for voices, sound effects and music.
