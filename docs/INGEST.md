# Frame ingest

Another app on the same computer can send Lumen finished frames, and Lumen encodes each shot **once** into a master clip in the media library. It was built for GS Cinematic Studio (a FiveM resource that films GTA V frame by frame from the game's browser), but any renderer or capture tool can use it.

- **Why:** encoding in the sender and re-encoding on import is two lossy generations before the edit starts. Raw frames over loopback make the master the only generation before the final export.
- **Where:** `http://127.0.0.1:<port>/ingest/v1`, this computer only. The port is 47911 unless it's taken.
- **Switch it on:** *Integrations › Frame ingest* in Lumen, or the `ingest_start` tool. The pane shows the address and token to copy.

## The master

One `.mp4` per clip, named after the clip: exactly the frames sent, at exactly the frame rate asked for, with no audio.

| Quality | What it is | 1440p, per frame |
| --- | --- | --- |
| `master` (default) | VP9 4:4:4 8-bit, BT.709. Visually lossless: about 47–48 dB against the frames sent. | ~0.5–0.8 MB |
| `lossless` | VP9 4:4:4 coded as RGB. **Every pixel exactly as sent** (checked byte for byte with ffmpeg). | ~3.5 MB |
| `compact` | VP9 4:4:4 8-bit, BT.709. High quality: about 46 dB. | ~0.25–0.4 MB |

Notes on the format:

- **Colour:** full colour resolution (4:4:4) in every quality. The file is tagged with what it holds (BT.709 limited range, or sRGB as RGB for lossless), and there is no brightness or saturation shift: the mean error is under a tenth of a code value.
- **Same on every graphics card:** VP9 4:4:4 is encoded and decoded on the processor, on every computer, so the picture doesn't depend on the card or its driver.
- **Proxies:** clips 2560 px or larger also get a small H.264 proxy, made from the same frames, so they play smoothly straight away. Exports always read the master.
- **Where they go:** Lumen's media folder, or the folder chosen in the pane. Masters are large; a minute of 1440p is about 1 GB at `master`.

## Endpoints

Every request except `OPTIONS` carries `Authorization: Bearer <token>`. Errors are JSON: `{ "error": "<code>", "message": "<text>" }`, with the HTTP status saying what kind.

| Method and path | Body | Answer |
| --- | --- | --- |
| `GET /health` | – | `200 { "ok": true, "app": "lumen", "version", "formats", "origins", "qualities", "quality", "ready" }` |
| `POST /clips` | JSON, below | `201 { "clip_id", "quality" }` |
| `PUT /clips/{clip_id}/frames/{index}` | the frame's bytes | `204` |
| `POST /clips/{clip_id}/finish` | `{ "frames": <count sent> }` | `202 { "status": "assembling" }` |
| `GET /clips/{clip_id}` | – | the status object, below |
| `GET /clips` | – | `200 { "clips": [status objects, newest first] }` |
| `DELETE /clips/{clip_id}` | – | `204`; everything received is discarded |

### `POST /clips`

```json
{
  "name": "silhouette_arrival_04_valet",
  "width": 2560, "height": 1440, "fps": 30, "frames": 100,
  "format": "rgba",
  "origin": "top-left",
  "quality": "master",
  "meta": { "source": "gs-cinematic-studio", "project": "...", "scene": "...", "shot": "...", "from": 440, "to": 540, "aspect": "16:9",
            "cues": [ { "at": 1.5, "kind": "speech", "speaker": "Boss", "text": "You are late.", "seconds": 1.5 } ] }
}
```

| Field | |
| --- | --- |
| `name` | The clip's name in the media library and its file name. |
| `width`, `height` | Even, 16 to 7680×4320. Any shape: 2560×1080 and 1080×1920 are fine. |
| `fps` | 1 to 240. Fractions are fine (23.976, 59.94). |
| `frames` | How many you plan to send. Optional; `finish` is what counts. |
| `format` | `rgba` (default), `bgra` or `png`. |
| `origin` | `top-left` (default) or `bottom-left`, for raw frames. WebGL reads bottom-up, so `bottom-left` saves the sender a flip. |
| `quality` | `master`, `lossless` or `compact`. Left out, Lumen uses the one set in its pane. |
| `meta` | Anything worth keeping, as JSON. It stays with the clip in the media library. `meta.source` tags the clip; `meta.cues` becomes its cues (below). |

The whole request may be up to 2 MB. Lists and objects inside `meta` are kept up to 512 KB together; anything beyond that is left out, and the clip is still taken.

### Cues

A master has no sound. `meta.cues` says what happens in it, so the soundtrack can be built to the picture:

```json
[ { "at": 0,   "kind": "cut",    "shot": "Arrival", "seconds": 3.3 },
  { "at": 0.2, "kind": "walk",   "speaker": "Boss", "style": "confident", "seconds": 0.6 },
  { "at": 1.5, "kind": "speech", "speaker": "Boss", "text": "You are late.", "seconds": 1.5 },
  { "at": 2.8, "kind": "sfx",    "sound": "door_slam" } ]
```

- **`at`** is seconds from the clip's first frame, and is all a cue needs. `kind` is any word; `seconds` is how long it lasts.
- **Named by** the first of `text`, `label`, `shot`, `sound`, `effect` and a few more that is there; `speaker` or `who` says whose it is. Every other field is kept as it came.
- **In Lumen** they show along the bottom of the clip on the timeline, following its trims and speed. Right-click the clip for *Add markers at the cues*.
- **For agents**, `ingest_status` lists a finished clip's cues, and `get_clip` gives them at timeline seconds once the clip is placed.
- Up to 2,000 cues per clip. Cues outside the clip are dropped.

### Frames

- **Order:** `index` counts from 0. Send frames in order, one request at a time per clip. An out-of-order index is `409` with `expected`.
- **`rgba` / `bgra`:** exactly `width × height × 4` bytes, 8-bit, sRGB, full range. Alpha is ignored. A wrong length is `400` with `expected` and `got`.
- **`png`:** one PNG file of the clip's size per frame.
- **Backpressure:** the `204` comes once Lumen has room for the frame. A sender that is faster than the encoder simply waits a little for its answer; nothing piles up and nothing is dropped.
- **Retries:** sending the frame that was just accepted again is answered `204` again and not counted twice, so a dropped answer is safe to retry.
- **Several clips at once** are fine (two outputs of one shot, frame by frame in turn), up to six.

### Status

```json
{ "clip_id": "...", "name": "...", "status": "receiving | assembling | done | error",
  "received": 100, "encoded": 100, "frames": 100, "quality": "master",
  "asset_id": "asset_...", "path": "C:\\...\\clip.mp4", "duration_seconds": 3.333,
  "codec": "VP9 4:4:4 8-bit (visually lossless)", "bytes": 76000000, "error": "..." }
```

`asset_id`, `path`, `duration_seconds`, `codec` and `bytes` are there once `status` is `done`. Frames are encoded as they arrive, so `finish` only has the file's index left to write: poll once a second and it is usually done on the first or second look.

`finish` with a count that isn't what Lumen received is `409` with `received`.

### Errors worth handling

| Status | `error` | Meaning |
| --- | --- | --- |
| 400 | `bad_size`, `bad_fps`, `bad_format`, `bad_frame_size`… | The request is wrong; the message says how. |
| 401 | `unauthorized` | Missing or wrong token. |
| 404 | `no_such_clip` | Unknown or deleted clip. |
| 409 | `out_of_order`, `frame_count_mismatch`, `not_receiving`, `clip_failed` | See `expected` / `received`; `clip_failed` carries the encoder's error. |
| 429 | `too_many_clips` | Six clips are already arriving. |
| 503 | `editor_unavailable`, `encoder_stalled` | Lumen's window isn't ready, or its encoder stopped taking frames. |

A clip with no activity for ten minutes is given up on.

## From a web page (CORS)

The sender is usually a page with its own origin (`https://cfx-nui-gs-cinematic-studio`) calling `http://127.0.0.1`, so the browser preflights every request. Lumen answers `OPTIONS` on every path without a token:

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS
Access-Control-Allow-Headers: Authorization, Content-Type
Access-Control-Allow-Private-Network: true
Access-Control-Max-Age: 600
```

and sends `Access-Control-Allow-Origin: *` on every real answer. The token is what protects the endpoint: it is random, kept in Lumen's settings, and can be replaced from the pane (*New token*).

## For agents

- `ingest_start` starts the receiver if needed and returns `{ url, token, formats, quality, folder }`. Pass `url` and `token` to the sender — GS Cinematic Studio's `render_export` takes them as `lumen_url` and `lumen_token`.
- `ingest_status` lists recent clips with their status, `meta`, and for finished ones the `asset_id` and cues. Then `place_asset` puts a clip on the timeline, and `get_clip` gives its cues at timeline seconds.

## Try it without a sender

```bash
B=http://127.0.0.1:47911/ingest/v1; T=<token>
curl -s -X OPTIONS -i "$B/clips" -H "Origin: https://cfx-nui-gs-cinematic-studio" \
     -H "Access-Control-Request-Method: PUT" -H "Access-Control-Request-Headers: authorization,content-type"
ID=$(curl -s -X POST "$B/clips" -H "Authorization: Bearer $T" -H "Content-Type: application/json" \
     -d '{"name":"ingest_test","width":64,"height":36,"fps":30,"frames":30,"format":"rgba","quality":"lossless"}' \
     | python -c "import sys,json;print(json.load(sys.stdin)['clip_id'])")
for i in $(seq 0 29); do
  python -c "import sys;i=$i;sys.stdout.buffer.write(bytes([i*8,64,255-i*8,255])*64*36)" |
    curl -s -X PUT "$B/clips/$ID/frames/$i" -H "Authorization: Bearer $T" --data-binary @-
done
curl -s -X POST "$B/clips/$ID/finish" -H "Authorization: Bearer $T" -H "Content-Type: application/json" -d '{"frames":30}'
curl -s "$B/clips/$ID" -H "Authorization: Bearer $T"
```

The preflight answers 204 with the headers above, and the last call reaches `"status": "done"` with an `asset_id`. The clip is one second of 64×36 going from blue-violet to red-orange. With `lossless` its first frame is exactly `rgb(0, 64, 255)`; with `master` it is within one code value.

## How it works inside

- **Receiver** ([`electron/ingest.ts`](../electron/ingest.ts)): a loopback HTTP server in the main process. It checks each frame's size as it arrives and holds at most two frames per clip.
- **Encoder** ([`src/project/ingest.worker.ts`](../src/project/ingest.worker.ts)): a worker in the editor pulls frames from the receiver (off the editor's thread), converts them to the master's colour with exact BT.709 maths ([`ingest-convert.ts`](../src/project/ingest-convert.ts)), encodes with WebCodecs and writes the MP4 with Mediabunny.
- **Contract** ([`shared/ingest.ts`](../shared/ingest.ts)): request checking, qualities and codec strings, shared by both halves.
