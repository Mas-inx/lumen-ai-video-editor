const pad = (n: number) => String(n).padStart(2, '0')

/** HH:MM:SS:FF — broadcast-style timecode. */
export function formatTimecode(frame: number, fps: number, withFrames = true) {
  const f = Math.max(0, Math.floor(frame))
  const total = Math.floor(f / fps)
  const h = Math.floor(total / 3600)
  const m = Math.floor(total / 60) % 60
  const s = total % 60
  const base = `${pad(h)}:${pad(m)}:${pad(s)}`
  return withFrames ? `${base}:${pad(f % fps)}` : base
}

/** Human, compact duration: "4.5s", "1:05", "1:02:03". */
export function formatDuration(frames: number, fps: number) {
  const sec = frames / fps
  if (sec < 60) return `${sec < 10 ? sec.toFixed(1) : Math.round(sec)}s`
  const total = Math.round(sec)
  const h = Math.floor(total / 3600)
  const m = Math.floor(total / 60) % 60
  const s = total % 60
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

/** m:ss for seconds (asset lengths). */
export function formatSeconds(sec: number) {
  const total = Math.round(sec)
  return `${Math.floor(total / 60)}:${pad(total % 60)}`
}

/** Parses "SS", "MM:SS", "HH:MM:SS" or "HH:MM:SS:FF" into frames. */
export function parseTimecode(input: string, fps: number): number | null {
  const parts = input.trim().split(/[:;.]/).map((p) => Number(p))
  if (!parts.length || parts.some((p) => !Number.isFinite(p) || p < 0)) return null
  let h = 0, m = 0, s = 0, f = 0
  if (parts.length === 1) [s] = parts
  else if (parts.length === 2) [m, s] = parts
  else if (parts.length === 3) [h, m, s] = parts
  else [h, m, s, f] = parts
  return Math.round((h * 3600 + m * 60 + s) * fps + f)
}
