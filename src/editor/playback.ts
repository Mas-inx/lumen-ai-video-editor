/**
 * Playback clock. Frame-accurate, driven by requestAnimationFrame. At normal
 * speed the picture follows the audio engine's clock (so sound and picture
 * never drift apart); shuttling and silent playback follow the wall clock.
 */
import { create } from 'zustand'
import { audioEngine } from '@/engine/audio-engine'
import { projectDuration } from './ops'
import { useEditor } from './store'

interface PlaybackState {
  frame: number
  playing: boolean
  /** 1 = realtime; negative plays backwards; 2/4/8 = J/L shuttle */
  rate: number
  loop: boolean
  volume: number
  muted: boolean
}

export const usePlayback = create<PlaybackState>(() => ({
  frame: 0,
  playing: false,
  rate: 1,
  loop: false,
  volume: 0.8,
  muted: false,
}))

let raf = 0
let anchorTime = 0
let anchorFrame = 0
/** Audio-clock time that corresponds to `anchorFrame`, when sound is playing. */
let anchorAudio: number | null = null

const fps = () => useEditor.getState().project.settings.fps
const endFrame = () => Math.max(1, projectDuration(useEditor.getState().project))

/** Restarts the clock (and the sound) at `frame`. */
function anchor(frame: number, rate: number) {
  anchorFrame = frame
  anchorTime = performance.now()
  if (rate === 1) anchorAudio = audioEngine.start(useEditor.getState().project, frame / fps())
  else {
    anchorAudio = null
    audioEngine.stop()
  }
}

function elapsedSeconds(now: number) {
  if (anchorAudio !== null && audioEngine.isRunning()) return Math.max(0, audioEngine.now() - anchorAudio)
  return (now - anchorTime) / 1000
}

function tick(now: number) {
  const { rate, loop } = usePlayback.getState()
  const end = endFrame()
  let f = anchorFrame + elapsedSeconds(now) * fps() * (anchorAudio !== null ? 1 : rate)
  if (rate > 0 && f >= end) {
    if (!loop) {
      raf = 0
      audioEngine.stop()
      anchorAudio = null
      usePlayback.setState({ frame: end, playing: false, rate: 1 })
      return
    }
    anchor(0, rate)
    f = 0
  } else if (rate < 0 && f <= 0) {
    raf = 0
    usePlayback.setState({ frame: 0, playing: false, rate: 1 })
    return
  }
  const frame = Math.floor(f)
  if (frame !== usePlayback.getState().frame) usePlayback.setState({ frame })
  raf = requestAnimationFrame(tick)
}

export const playback = {
  play(rate = 1) {
    let start = usePlayback.getState().frame
    if (rate > 0 && start >= endFrame() - 1) start = 0
    anchor(start, rate)
    usePlayback.setState({ playing: true, rate, frame: start })
    if (!raf) raf = requestAnimationFrame(tick)
  },
  pause() {
    cancelAnimationFrame(raf)
    raf = 0
    anchorAudio = null
    audioEngine.stop()
    usePlayback.setState({ playing: false, rate: 1 })
  },
  toggle() {
    if (usePlayback.getState().playing) playback.pause()
    else playback.play()
  },
  seek(frame: number) {
    const f = Math.max(0, Math.round(frame))
    const { playing, rate } = usePlayback.getState()
    if (playing) anchor(f, rate)
    else {
      anchorFrame = f
      anchorTime = performance.now()
    }
    usePlayback.setState({ frame: f })
  },
  step(delta: number) {
    playback.pause()
    playback.seek(usePlayback.getState().frame + delta)
  },
  /** J / L: press repeatedly to double speed; the opposite key slows and reverses. */
  shuttle(direction: 1 | -1) {
    const { playing, rate } = usePlayback.getState()
    const next = playing && Math.sign(rate) === direction ? Math.max(-8, Math.min(8, rate * 2)) : direction
    anchor(usePlayback.getState().frame, next)
    usePlayback.setState({ playing: true, rate: next })
    if (!raf) raf = requestAnimationFrame(tick)
  },
  toggleLoop() {
    usePlayback.setState((s) => ({ loop: !s.loop }))
  },
  end: endFrame,
}

// Master volume follows the transport's volume / mute controls.
audioEngine.setVolume(usePlayback.getState().volume, usePlayback.getState().muted)
usePlayback.subscribe((s, prev) => {
  if (s.volume !== prev.volume || s.muted !== prev.muted) audioEngine.setVolume(s.volume, s.muted)
})

// Edits made while playing are heard right away.
let refreshTimer: ReturnType<typeof setTimeout> | undefined
useEditor.subscribe((s, prev) => {
  // Only clips and tracks change the mix (waveform analysis updates assets in the background).
  if ((s.project.clips === prev.project.clips && s.project.tracks === prev.project.tracks) || !usePlayback.getState().playing || anchorAudio === null) return
  clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => {
    if (usePlayback.getState().playing && anchorAudio !== null) audioEngine.refresh(useEditor.getState().project)
  }, 60)
})
