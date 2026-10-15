# Recording

Lumen records a screen, a window or part of either straight into the project: the picture at up to 4K and 60 frames a second, the computer's sound or one app's, the microphone, the camera, and where the pointer clicked. When the recording stops, the clips are in the media library and on the timeline, lined up.

Open it with the red dot in the title bar, **Ctrl Shift R**, or *Record a screen or window* in the command palette. The Copilot and any agent on Lumen's MCP server can record too ([tools](AI-TOOLS.md#record)).

## What you can set

| Setting | What it does |
| --- | --- |
| **Source** | A whole screen, or one window. A window is recorded even while another window covers it; a minimized window has nothing to record. |
| **Part** | Drag over the live picture to record only that region. |
| **Resolution** | *Native* is the source's own pixels. *4K, 1440p, 1080p, 720p* name the short side and keep the source's shape, scaling up or down. Neither side ever passes 3840. |
| **Frame rate** | 24, 25, 30, 50 or 60. |
| **Codec** | H.264, HEVC or AV1. |
| **Encoder** | The graphics card, or the processor. |
| **Quality** | *Auto* works a bitrate out from the size, frame rate and codec; *Bitrate* takes megabits a second. |
| **Key frames** | Every 1, 2, 5 or 10 seconds. More often scrubs faster; less often makes smaller files. |
| **Pointer** | In the picture, or left out. |
| **Clicks** | Where the pointer was and when it clicked, kept as data beside the picture. |
| **Computer sound** | Off, everything the computer plays, or only the app whose window is recorded. |
| **Microphone, Camera** | Each recorded as a clip of its own. |
| **Colours** | On a screen that shows more than sRGB: label the file *Standard* (what games and most apps mean) or *This screen's* (what browsers and design apps really showed). |
| **Countdown** | None, 3, 5 or 10 seconds. |
| **Lumen** | Kept out of a screen recording, and optionally minimized while recording. |

**Keys that work while another app is in front:** Ctrl Alt R starts and stops, Ctrl Alt P pauses, Ctrl Alt M marks a moment. If another app already owns one of them, use the buttons.

## What you get

- **The recording** as an MP4 on the main track, with its sound.
- **The camera** as a clip on a track above it, in the bottom right corner.
- **The microphone** as a clip on a voice track.
- All three start at the same moment and are grouped, so they move together. An empty timeline takes the recording's size and frame rate.
- **Markers** become cues on the clip.
- **Clicks** show in the Inspector under *Clicks*: *Zoom on clicks* pushes in on each click and eases back out, and *Highlight clicks* draws a pulse where each landed. Both are ordinary keyframes and clips afterwards.

Files go to `Videos\Lumen Recordings` unless you choose another folder.

## How it works

**Picture.** Chromium captures the source (Windows Graphics Capture for a window, desktop duplication for a screen) and hands Lumen each frame. A worker per file ([`src/capture/capture.worker.ts`](../src/capture/capture.worker.ts)) crops and scales inside the encoder and writes at a constant frame rate. There is no canvas in the path, which is what lets large frames keep up.

**Encoders.** The same ones an export uses, chosen the same way: each candidate is tried with real frames at the recording's size before it is trusted. With the graphics card wanted, the order is the codec asked for on the card, the other codecs on the card, then the processor. This is what makes it work on integrated Intel, NVIDIA and AMD alike: a card that can't take the size or the codec is passed over, and a computer with no usable card encodes on the processor.

**If an encoder stops part-way** (a driver reset, a game changing the display mode), or the window being recorded changes size, the file ends there and the recording carries on in a new one within about half a second. The parts land on the timeline back to back, and the recording says what happened.

**Frame rate.** Each frame takes its place in the file by when it was captured, on an exact grid of the frame rate you chose. While the source is still (a window where nothing moves sends nothing), the last picture is written again, so the file keeps its frame rate. A place missed while frames are arriving is left empty and the picture before it lasts that much longer: on a graphics card shared with what is being recorded, encoding a repeat would take time from the next real frame. The record window shows how many frames a second the source is sending, and how many the encoder had no time for.

**Timers.** Chromium takes a frame on a timer. From Windows 11, an app whose windows are all covered or minimized (Lumen, while you play the game you are recording) gets only coarse 15.6 ms timer ticks, and a timer set for 60 a second then fires on every second tick: 32 frames a second. Lumen does two things about it. While it records, the helper exempts Lumen's processes from that coarsening (and hands it back afterwards). And for a window, Chromium is asked for twice the frame rate, so even coarse ticks catch every place: on battery Chromium doesn't ask for fine timers at all. Chromium never sends a window faster than about 60, so this costs little; a screen is asked for its recording's own rate, because a fast display could really send twice as many full-size frames.

**Sound.** The computer's sound and the microphone come from Chromium. One app's sound comes from a small helper ([`native/capture-helper`](../native/capture-helper)) using Windows' process loopback. Each is placed by its own timestamps, so picture and sound stay together through pauses.

**Files.** A recording is written as a fragmented MP4: what has been recorded survives a crash, and nothing is held in memory. When it stops, the file is rewritten as an ordinary MP4 without encoding again. If Lumen closes unexpectedly mid-recording, the next start offers to recover it.

**Clicks.** The helper reads the pointer's position and buttons 120 times a second. Positions are stored as fractions of the recorded picture, so they survive scaling, and a window that was moved mid-recording is followed.

**Privacy.** Nothing leaves the computer. An AI has to be allowed by the user before it can list or record anything, once per session, and a red dot in the title bar shows whenever a recording runs.

## Limits

- **60 frames a second is the most** Chromium's capture delivers.
- **Scaling up costs processor time.** Recording a smaller source at 4K resizes every frame on the processor. On a laptop's built-in graphics that held about 50 frames a second in testing, where native size kept every frame the source sent. If frames are skipped, record at *Native* and export at 4K.
- **A game that draws fewer frames than you asked for** is recorded at the rate it draws, and a graphics chip shared by the game and the recording can lower both. The record window shows the rate the source is really sending.
- **A screen recorded on battery** may come in at about 32 frames a second, because Chromium doesn't ask Windows for fine timers on battery. Windows, and regions of windows, aren't affected.
- **One app's sound** needs Windows 11, or Windows 10 build 20348 or later. Elsewhere, and for whole screens, it falls back to everything the computer plays.
- **Exclusive full screen** games can only be recorded as a screen. Use windowed or borderless to record the game's window.
- **A window is recorded with its title bar.** Draw a region to leave it out.
- **Protected video** (some streaming apps) records as black.
- **HDR** is recorded as standard dynamic range.
- **Wide-gamut screens.** Capture hands over the numbers the screen was sent. On such a screen, apps that manage colour look slightly less saturated in a recording labelled *Standard*; *This screen's* labels the file so they look as they did.

## Filming GS Cinematic Studio

`record_studio_take` films a take of the open studio scene in real time: it finds the game's window, starts recording (picture and only the game's sound), has the studio play the take with every panel hidden (`film_take`), stops, and puts the clip on the timeline trimmed to exactly the take, with the studio's cue sheet attached.

It needs the studio connected in *Integrations* with a director's game under remote control, on this computer, with the game windowed or borderless. Frame ingest ([INGEST.md](INGEST.md)) stays the frame-exact route: any resolution, no sound, slower.
