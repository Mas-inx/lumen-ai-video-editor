/**
 * Keeps the media engine in step with the project: decodes audio for clips as
 * they land on the timeline (so play is instant), measures waveforms for media
 * that lacks them, and frees decoders for media that's gone.
 */
import { useEditor } from '@/editor/store'
import type { Project } from '@/editor/types'
import { analyzeAssets, releaseUnusedAudio } from '@/project/media-import'
import { ensureProxies } from '@/project/proxies'
import { audioEngine, audioLeaves, audioStream, isLongAudio, loadAudio } from './audio-engine'
import { allRenderKeys } from './compositor'
import { registerProjectFonts } from './fonts'
import { pruneVideos } from './media'

function prefetch(project: Project) {
  for (const { clip, view } of audioLeaves(project)) {
    const asset = view.assets[clip.assetId!]
    // Long recordings stream; just have their reader ready.
    if (isLongAudio(asset)) void audioStream(asset)
    else void loadAudio(asset)
  }
}

let started = false

export function startMediaEngine() {
  if (started) return
  started = true
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
      clearTimeout(pruneTimer)
      pruneTimer = setTimeout(() => {
        const project = useEditor.getState().project
        pruneVideos(allRenderKeys(project))
        releaseUnusedAudio()
      }, 4000)
    }
  })
  prefetch(useEditor.getState().project)
  registerProjectFonts(useEditor.getState().project)
  ensureProxies(useEditor.getState().project)
  audioEngine.warm()
}
