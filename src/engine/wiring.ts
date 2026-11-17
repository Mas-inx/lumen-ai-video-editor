/**
 * Keeps the media engine in step with the project: decodes audio for clips as
 * they land on the timeline and as the playhead nears them (so play is instant),
 * measures waveforms for media that lacks them, and frees decoders for media
 * that's gone.
 */
import { usePlayback } from '@/editor/playback'
import { useEditor } from '@/editor/store'
import type { Project } from '@/editor/types'
import { analyzeAssets, releaseUnusedAudio } from '@/project/media-import'
import { ensureProxies } from '@/project/proxies'
import { watchSmartTransitions } from '@/project/transition-actions'
import { audioEngine, prefetchAudio } from './audio-engine'
import { allRenderKeys } from './compositor'
import { registerProjectFonts } from './fonts'
import { pruneVideos } from './media'

/** Sound is got ready around the playhead again once it has moved this far (seconds). */
const PREFETCH_MOVE = 10

let prefetchedAt = 0

function prefetch(project: Project) {
  prefetchedAt = usePlayback.getState().frame / project.settings.fps
  prefetchAudio(project, prefetchedAt)
}

let cueTimer: ReturnType<typeof setTimeout> | undefined

/** Once the playhead rests, long recordings under it get their first stretch decoded, so play starts them on time. */
function cueSoon() {
  clearTimeout(cueTimer)
  cueTimer = setTimeout(() => {
    const { frame, playing } = usePlayback.getState()
    const project = useEditor.getState().project
    if (!playing) audioEngine.cue(project, frame / project.settings.fps)
  }, 150)
}

/** Looping: where playback comes back to (the marked stretch's start when it plays inside it) stays cued, so each pass starts on time too. */
function cueLoop(frame: number) {
  const project = useEditor.getState().project
  const range = project.range
  const back = range && frame >= range.in && frame < range.out ? range.in : 0
  audioEngine.cue(project, back / project.settings.fps)
}

let started = false

export function startMediaEngine() {
  if (started) return
  started = true
  // Smart transitions that arrive without a reading of their cut get one.
  watchSmartTransitions()
  let pruneTimer: ReturnType<typeof setTimeout> | undefined
  useEditor.subscribe((s, prev) => {
    if (s.project.fonts !== prev.project.fonts) registerProjectFonts(s.project)
    if (s.project.id !== prev.project.id) {
      // A different project was opened: measure anything it's missing.
      void analyzeAssets()
    }
    if (s.project.assets !== prev.project.assets) ensureProxies(s.project)
    if (s.project.clips !== prev.project.clips || s.project.tracks !== prev.project.tracks) {
      prefetch(s.project)
      cueSoon()
      clearTimeout(pruneTimer)
      pruneTimer = setTimeout(() => {
        const project = useEditor.getState().project
        pruneVideos(allRenderKeys(project))
        releaseUnusedAudio()
      }, 4000)
    }
  })
  usePlayback.subscribe((s, prev) => {
    if (!s.playing && (s.frame !== prev.frame || prev.playing)) cueSoon()
    // Starting to loop, or just come round again.
    else if (s.playing && s.loop && s.rate === 1 && (!prev.playing || !prev.loop || s.frame < prev.frame)) cueLoop(s.frame)
    if (s.frame === prev.frame) return
    const project = useEditor.getState().project
    if (Math.abs(s.frame / project.settings.fps - prefetchedAt) >= PREFETCH_MOVE) prefetch(project)
  })
  prefetch(useEditor.getState().project)
  cueSoon()
  registerProjectFonts(useEditor.getState().project)
  ensureProxies(useEditor.getState().project)
  audioEngine.warm()
}
