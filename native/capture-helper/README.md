# lumen-capture-helper

A small Windows program that Lumen's screen recorder starts as a child process. It
provides the three things Chromium cannot:

1. the sound of **one application** (WASAPI process loopback);
2. the **mouse cursor** as data: position, button presses, shape;
3. facts about **top-level windows**: owning process, exe name, exact rectangles.

It can also bring a window to the front (`focus`), so a game is the active window
while it is being recorded, and keep Windows honouring Lumen's timers while Lumen
is covered (`timers`).

It is C# 5 against .NET Framework 4.8, which is part of Windows 10 and 11, and it
references nothing but `mscorlib`. x64, no admin rights, no installer, no third-party
code. All coordinates are physical pixels (the manifest declares per-monitor-v2 DPI
awareness).

## Build

```
node scripts/build-capture-helper.mjs               # always build
node scripts/build-capture-helper.mjs --if-missing  # only when the exe is missing or older than a source
```

This compiles `native/capture-helper/*.cs` into `native/bin/lumen-capture-helper.exe`
(git-ignored) with the compiler that ships with Windows:

```
C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /noconfig /target:exe /platform:x64
  /optimize+ /debug- /unsafe /warn:4 /codepage:65001 /utf8output
  /win32manifest:native\capture-helper\app.manifest /out:native\bin\lumen-capture-helper.exe
  native\capture-helper\*.cs
```

A build takes well under a second. On another platform, or when that compiler is
missing, the script prints one line and exits 0. A compile error prints the
compiler's output and exits non-zero.

Because the compiler is C# 5, the sources do not use string interpolation, `?.`,
`nameof`, expression-bodied members or `out var`.

## Command line

Text output is ASCII JSON (anything else is written as `\uXXXX`), so it is also
valid UTF-8 without a BOM. Times `t` are Unix epoch milliseconds with three
decimals, taken from `GetSystemTimePreciseAsFileTime`.

| Exit code | Meaning |
| --- | --- |
| 0 | done, or asked to stop |
| 1 | failed (`"code":"failed"`) |
| 2 | no such process or window (`"code":"no-process"`) |
| 3 | this Windows cannot do it (`"code":"unsupported"`) |
| 64 | unknown command or bad arguments (`"code":"failed"`) |

An error is one line on stderr, `{"error":"A plain sentence.","code":"..."}`, and a
non-zero exit code. There is never a crash dialog.

The two long-running modes (`audio`, `cursor`) stop when stdin reaches end-of-file
or when a line `stop` arrives on stdin. Start them with stdin as a pipe and keep it
open: a closed or missing stdin stops them at once. The exit follows within about
120 ms even if Windows is holding the capture thread.

### `version`

```
{"version":"1.0.0","build":26200,"processLoopback":true}
```

`build` is the Windows build number; `processLoopback` is true from build 20348.

### `windows`

One JSON array, one entry per top-level window a person could pick: visible, not
cloaked, titled, not a tool window, not zero-sized, and not the desktop itself.
Front-most first. Minimized windows are included.

```
{"hwnd":131876,"pid":9692,"process":"chrome.exe","title":"...",
 "rect":{"x":0,"y":0,"width":3120,"height":1984},
 "client":{"x":0,"y":0,"width":3120,"height":1984},"minimized":false}
```

- `rect` is the visible frame (`DWMWA_EXTENDED_FRAME_BOUNDS`, else `GetWindowRect`);
  `client` is the client area in screen coordinates.
- `process` is the exe's file name, or `""` when it cannot be read.
- For a Store (UWP) app the top-level window belongs to `ApplicationFrameHost.exe`;
  `pid` and `process` are those of the app inside it.
- For a minimized window the rectangles are what Windows reports for the minimized
  stub (around -32000, -32000), not where the window will be when restored.

### `window --hwnd <n>`

The same object for one window, including ones the list leaves out. Exit 2 with
`"code":"no-process"` when there is no such window. `<n>` may be decimal or `0x` hex.

### `focus --hwnd <n>`

Brings that window to the front: restores it if it is minimized, then makes it the
foreground window. One JSON line, exit 0 whether or not it worked:

```
{"focused":true,"foreground":131876,"hwnd":131876}
```

- `foreground` is the window in front afterwards. `focused` is true when that is
  the window asked for, or a window it owns (a dialog of the same app).
- Windows decides who may take the foreground. A process started by the foreground
  app may, which is how Lumen runs this. If the plain request is refused, the
  helper joins the input queue of the thread that owns the foreground window
  (`AttachThreadInput`), asks again, and leaves the queue. It never sends key
  presses or mouse input to get its way, so `focused` can be false: for instance
  when the app in front runs as administrator.
- Exit 2 with `"code":"no-process"` when there is no such window.
- It gives up after 3 seconds (answering `"focused":false`) rather than wait on an
  app that does not respond.

### `timers --pid <n> [--pid <n> ...] [--release]`

From Windows 11, a process whose windows are all covered, minimized or otherwise out
of sight no longer gets the timer resolution it asked for: its timers fall back to
15.6 ms ticks. Chromium captures a screen or a window on a timer in Lumen's main
process, so with a game in front of Lumen a 60 fps capture got a frame every second
tick, 32 a second. This exempts the processes given
(`PROCESS_POWER_THROTTLING_IGNORE_TIMER_RESOLUTION` controlled and off); `--release`
hands the choice back to Windows. Only that bit is changed: whatever else a process
set for itself (efficiency mode, for one) stays. One JSON line, exit 0:

```
{"needed":true,"held":true,"set":[1552,7460],"failed":[{"pid":4,"error":5}]}
```

- `failed` lists each process that could not be changed, with the Windows error code
  (5: access denied, 87: no such process).
- Before Windows 11 (build 22000) Windows does not do this: `needed` is false and
  nothing is changed.
- It changes nothing a process does by itself: a process that never asks for finer
  timers (Chromium on battery) keeps the 15.6 ms ticks.

### `audio (--pid <n> | --hwnd <n>) [--exclude] [--stats]`

The sound of that process and its child processes; with `--exclude`, everything
except that process tree. `--hwnd` uses the window's process (as `windows` reports it).

stdout is one line of JSON, then raw samples with no framing:

```
{"sampleRate":48000,"channels":2,"format":"f32le","pid":1234,"t":1760356800123.456}
<interleaved 32-bit float little-endian stereo, forever>
```

- `t` is the time of the first sample. Sample `n` belongs at `t + n / 48` ms: the
  stream is continuous. When the app is silent or Windows delivers nothing, zeros
  are written so the count keeps pace with the clock.
- Each packet (10 ms) is written as soon as it arrives. While nothing arrives,
  silence is written every 10 ms, about 30 ms behind the clock.
- The helper can be started before the app has made any sound.
- It ends when stdin closes or says `stop`, or when the target process exits. In
  the last case stderr gets `{"event":"ended","reason":"process-exited"}` and the
  exit code is 0. A restarted app is a new process: start a new helper for it.
- If the reader stops reading, up to 20 seconds of audio are held; past that, sound
  is dropped and its time comes out as silence, so the sample count stays right.
- `--stats` adds one `{"event":"stats",...}` line a second on stderr (packets,
  frames against the clock, silence inserted, longest pause). For testing.

Needs Windows build 20348 or later; on older builds it exits 3 with
`"code":"unsupported"`. A process id that is not running exits 2 with
`"code":"no-process"`.

Things Windows does, measured on build 26200, that a caller should know:

- When another audio stream opens or closes inside the captured process tree,
  40 to 60 ms of the app's sound is missing from the capture (it arrives as
  silence). A stream opening in an unrelated app does not do this.
- When the target opens its first stream, a call into Windows blocks the capture
  thread for about half a second. Nothing is lost (no sound is delivered during
  that time either) and stdout keeps flowing with silence meanwhile.
- Windows keeps only about 30 ms of this audio for a slow reader, which is why the
  helper reads on its own high-priority thread and queues for stdout.
- The capture can carry audio effects applied on the way: on the test PC, which
  has the Nahimic enhancer installed, tones from 620 Hz up were captured 4 dB
  louder than they were played, and a 440 Hz tone at the level it was played.

### `cursor [--hz <30..240, default 120>] [--hwnd <n>] [--stats]`

JSON lines on stdout, one event per line, each written at once.

```
{"e":"start","t":...,"hz":120,"screen":{"x":0,"y":0,"width":3120,"height":2080}}
{"e":"shape","t":...,"shape":"arrow","visible":true}
{"e":"window","t":...,"rect":{...},"client":{...},"minimized":false,"foreground":true}
{"e":"move","t":...,"x":2573,"y":840}
{"e":"down","t":...,"x":2573,"y":840,"button":"left"}
{"e":"up","t":...,"x":2573,"y":840,"button":"left"}
{"e":"window","t":...,"gone":true}
```

- `start` comes first; `screen` is the virtual screen. Then the current `shape`,
  the `window` (with `--hwnd`), and one `move` with the current position.
- `move`: the position changed since the last sample.
- `down` / `up`: `button` is `left`, `right` or `middle`, as the click is delivered
  to apps (so "left" is the physical right button when the buttons are swapped). A
  press and release that both fall between two samples are reported as a `down`
  and an `up` with the same `t`. A button already held at the start is not
  reported until it is released.
- `shape`: `arrow`, `ibeam`, `hand`, `wait`, `cross`, `size`, `no` or `other` (an
  app's own cursor), and whether the cursor is visible. Sent when either changes.
- `window` (with `--hwnd`): checked about ten times a second, sent when the
  rectangles, `minimized` or `foreground` change. `foreground` is true when the
  window, or a window it owns, is the foreground window. `{"gone":true}` once if it
  closes; the helper keeps running.
- The cursor is polled on a high-resolution timer. No hooks are installed.
- `--stats` prints one `{"event":"stats",...}` line on stderr at the end (samples
  taken, average and longest interval). For testing.

## Files

| File | What is in it |
| --- | --- |
| `Program.cs` | `Main`, arguments, `version`, errors and exit codes |
| `ProcessLoopback.cs` | `audio`: activation, the capture and writer threads, the timeline |
| `Cursor.cs` | `cursor` |
| `Windows.cs` | `windows`, `window`, window geometry and process names |
| `Focus.cs` | `focus` |
| `Timers.cs` | `timers` |
| `Output.cs` | clocks, stdout/stderr, JSON text, the stdin watcher |
| `Interop.cs` | Win32 and COM declarations |
| `app.manifest` | `asInvoker`, per-monitor-v2 DPI awareness, Windows 10/11 compatibility |
