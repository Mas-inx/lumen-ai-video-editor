/**
 * Playback clock. Frame-accurate, driven by requestAnimationFrame. At normal
 * speed the picture follows the audio engine's clock (so sound and picture
 * never drift apart); shuttling and silent playback follow the wall clock.
 *
 * With in and out points set, "play in to out" plays just that stretch, and
 * looping from inside it loops the stretch.
 */
import { create } from 'zustand'
import { audioEngine } from '@/engine/audio-engine'
import { projectDuration } from './ops'
import { useEditor } from './store'
import type { Track } from './types'

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
/** Playing in to out: stop (or loop) at the out point. */
let inToOut = false

const fps = () => useEditor.getState().project.settings.fps
const endFrame = () => Math.max(1, projectDuration(useEditor.getState().project))
const markedRange = () => useEditor.getState().project.range ?? null

/** The stretch playback is confined to right now, if any. */
function playRange() {
  const range = markedRange()
  if (!range) return null
  if (inToOut) return range
  // Looping from inside the marked stretch loops the stretch.
  return usePlayback.getState().loop && anchorFrame >= range.in && anchorFrame < range.out ? range : null
}

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
  const range = playRange()
  const end = range ? range.out : endFrame()
  const restart = range ? range.in : 0
  let f = anchorFrame + elapsedSeconds(now) * fps() * (anchorAudio !== null ? 1 : rate)
  if (rate > 0 && f >= end) {
    if (!loop) {
      raf = 0
      audioEngine.stop()
      anchorAudio = null
      inToOut = false
      usePlayback.setState({ frame: range ? Math.max(range.in, end - 1) : end, playing: false, rate: 1 })
      return
    }
    anchor(restart, rate)
    f = restart
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
    inToOut = false
    let start = usePlayback.getState().frame
    if (rate > 0 && start >= endFrame() - 1) start = 0
    anchor(start, rate)
    usePlayback.setState({ playing: true, rate, frame: start })
    if (!raf) raf = requestAnimationFrame(tick)
  },
  /** Plays from the in point to the out point (the whole timeline when none are set). */
  playInToOut() {
    const range = markedRange()
    if (!range) return playback.play()
    playback.pause()
    inToOut = true
    anchor(range.in, 1)
    usePlayback.setState({ playing: true, rate: 1, frame: range.in })
    if (!raf) raf = requestAnimationFrame(tick)
  },
  pause() {
    cancelAnimationFrame(raf)
    raf = 0
    inToOut = false
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

/** Whether two track lists differ only in their mixer settings (faders, pan, processing). */
function onlyMixChanged(a: Track[], b: Track[]) {
  if (a.length !== b.length) return false
  return a.every((t, i) => {
    const { mix: _a, ...restA } = t
    const { mix: _b, ...restB } = b[i]
    return (Object.keys(restA) as (keyof typeof restA)[]).every((k) => restA[k] === restB[k]) && Object.keys(restA).length === Object.keys(restB).length
  })
}

// Edits made while playing are heard right away.
let refreshTimer: ReturnType<typeof setTimeout> | undefined
useEditor.subscribe((s, prev) => {
  if (!usePlayback.getState().playing || anchorAudio === null) return
  const clipsSame = s.project.clips === prev.project.clips
  // Moving a fader or pan, or tweaking an EQ, glides in place instead of restarting the sound.
  if (clipsSame && (s.project.tracks === prev.project.tracks || onlyMixChanged(s.project.tracks, prev.project.tracks))) {
    if (s.project.tracks !== prev.project.tracks || s.project.master !== prev.project.master) audioEngine.updateMix(s.project)
    return
  }
  // Only clips and tracks change what plays (waveform analysis updates assets in the background).
  clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => {
    if (usePlayback.getState().playing && anchorAudio !== null) audioEngine.refresh(useEditor.getState().project)
  }, 60)
})
