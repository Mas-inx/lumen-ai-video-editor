/**
 * App-level actions shared by keyboard shortcuts, menus, the command palette
 * and toolbar buttons — one implementation, many entry points.
 */
import { toast } from 'sonner'
import { copyClips, pasteClips } from '@/editor/clipboard'
import type { EditMode } from '@/editor/commands'
import { adjacentBefore, clipEnd, clipsAt, editPoints, projectDuration, withGroups } from '@/editor/ops'
import { playback, usePlayback } from '@/editor/playback'
import { dispatch, getProject, useEditor } from '@/editor/store'
import type { Tool } from '@/editor/ui-store'
import { useUI } from '@/editor/ui-store'
import { importDropped, pickAndImport } from '@/project/media-import'
import { openProject, saveProject, saveProjectAs, showHome } from '@/project/session'
import { openTimeline } from '@/editor/timeline-nav'
import { AnalysisCancelled, initialTrackBox, scenesInClip, stabilizeClip, withProgress } from '@/project/analysis-actions'

const ui = () => useUI.getState()
const frame = () => usePlayback.getState().frame
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** Shows a failed dispatch; true when it worked. */
function ok(res: { ok: true } | { ok: false; error: string }) {
  if (!res.ok) toast(res.error)
  return res.ok
}

/** The selected clips, or else the top video clip under the playhead. */
function targetClips(kinds?: string[]) {
  const p = getProject()
  const selected = ui().selection.map((id) => p.clips[id]).filter(Boolean)
  if (selected.length) return kinds ? selected.filter((c) => kinds.includes(c.kind)) : selected
  const order = new Map(p.tracks.map((t, i) => [t.id, i]))
  return clipsAt(p, frame())
    .filter((c) => !kinds || kinds.includes(c.kind))
    .sort((a, b) => (order.get(a.trackId) ?? 0) - (order.get(b.trackId) ?? 0))
    .slice(0, 1)
}

export const actions = {
  undo() {
    const entry = useEditor.getState().undo()
    if (entry?.source === 'ai') toast(`Undid Copilot: ${entry.label}`)
  },
  redo() {
    useEditor.getState().redo()
  },

  split() {
    const f = frame()
    const selected = ui().selection
    const underPlayhead = clipsAt(getProject(), f, selected)
    const ids = selected.length && underPlayhead.length ? underPlayhead.map((c) => c.id) : undefined
    const res = dispatch('clip.split', { frame: f, ids })
    if (!res.ok) toast(res.error)
  },

  deleteSelection(ripple = false) {
    const ids = ui().selection
    if (!ids.length) return
    const res = dispatch('clip.delete', { ids, ripple })
    if (res.ok) ui().clearSelection()
    else toast(res.error)
  },

  duplicateSelection() {
    const ids = ui().selection
    if (!ids.length) return
    const res = dispatch('clip.duplicate', { ids })
    if (res.ok) ui().select(res.result as string[])
  },

  // ── Clipboard ──

  copy() {
    const n = copyClips(getProject(), ui().selection)
    if (n) toast(`Copied ${plural(n, 'clip')}`)
  },

  cut() {
    const ids = ui().selection
    if (!copyClips(getProject(), ids)) return
    if (ok(dispatch('clip.delete', { ids, ripple: false }, { label: `Cut ${plural(ids.length, 'clip')}` }))) ui().clearSelection()
  },

  /** Pastes at the playhead (or `at`): free finds room, insert pushes clips later, overwrite covers them. */
  paste(mode: EditMode = 'free', at = frame()) {
    const res = pasteClips(at, mode)
    if (!res.ok) return void toast(res.error)
    ui().select(res.ids)
  },

  pasteAttributes() {
    if (!ui().selection.length) return void toast('Select the clips to paste attributes onto')
    ui().setPasteAttributesOpen(true)
  },

  // ── Linking & holds ──

  detachAudio() {
    const clips = targetClips(['video']).filter((c) => !c.audio.detached)
    if (!clips.length) return void toast('Select a video clip with sound to detach its audio')
    const res = dispatch('clip.detachAudio', { ids: clips.map((c) => c.id) })
    if (ok(res)) ui().select([...clips.map((c) => c.id), ...(res.result as string[])])
  },

  reattachAudio() {
    const clips = targetClips(['video']).filter((c) => c.audio.detached)
    if (!clips.length) return void toast('Select a video clip whose sound was detached')
    ok(dispatch('clip.reattachAudio', { ids: clips.map((c) => c.id) }))
  },

  toggleAudioLink() {
    const clips = targetClips(['video'])
    if (clips.some((c) => c.audio.detached)) actions.reattachAudio()
    else actions.detachAudio()
  },

  group() {
    const ids = ui().selection
    if (ids.length < 2) return void toast('Select two or more clips to group')
    if (ok(dispatch('clip.group', { ids }))) toast(`Grouped ${plural(withGroups(getProject(), ids).length, 'clip')}`)
  },

  ungroup() {
    const ids = ui().selection
    if (!ids.some((id) => getProject().clips[id]?.groupId)) return void toast('Nothing selected is grouped')
    ok(dispatch('clip.ungroup', { ids }))
  },

  /** Holds the frame under the playhead for two seconds. */
  freezeFrame() {
    const f = frame()
    const clip = targetClips(['video']).find((c) => f >= c.start && f < clipEnd(c))
    if (!clip) return void toast('Put the playhead over a video clip to freeze a frame')
    const res = dispatch('clip.freeze', { id: clip.id, frame: f, duration: getProject().settings.fps * 2 })
    if (ok(res)) ui().select([res.result as string])
  },

  /** Crossfades each selected clip with the one before it (a dissolve on video, a crossfade on sound). */
  crossfade() {
    const p = getProject()
    const clips = targetClips().filter((c) => adjacentBefore(p, c))
    if (!clips.length) return void toast('Select a clip that directly follows another to crossfade them')
    const duration = Math.round(p.settings.fps / 2)
    useEditor.getState().transaction(clips.length > 1 ? 'Add crossfades' : 'Add crossfade', 'user', () => {
      for (const c of clips) dispatch('clip.setTransition', { id: c.id, transition: c.transitionIn ?? { kind: 'dissolve', duration: Math.max(2, Math.min(duration, c.duration)) } })
    })
  },

  // ── Timelines & multicam ──

  /** Moves the selected clips (and anything linked) into a new timeline played by one clip. */
  nestSelection() {
    const ids = ui().selection
    if (!ids.length) return void toast('Select the clips to nest first')
    const res = dispatch('clip.nest', { ids })
    if (!ok(res)) return
    const { clipId, sequenceId } = res.result as { clipId: string; sequenceId: string }
    ui().select([clipId])
    toast.success('Nested into a new timeline', { action: { label: 'Open it', onClick: () => openTimeline(sequenceId, true) } })
  },

  /** Steps into the timeline a nested clip plays. */
  openNested(clipId?: string) {
    const id = clipId ?? ui().selection.find((x) => getProject().clips[x]?.sequenceId)
    const seq = id ? getProject().clips[id]?.sequenceId : undefined
    if (seq) openTimeline(seq, true)
  },

  /** Brings a nested clip's contents back onto this timeline. */
  unnestSelection() {
    const id = ui().selection.find((x) => getProject().clips[x]?.sequenceId)
    if (!id) return void toast('Select a nested clip to break apart')
    const res = dispatch('clip.unnest', { id })
    if (ok(res)) ui().select(res.result as string[])
  },

  /** Multicam: cut to camera `n` (1–9) at the playhead. */
  cutToAngle(n: number) {
    const p = getProject()
    const f = frame()
    if (!clipsAt(p, f).some((c) => c.sequenceId && p.sequences?.[c.sequenceId]?.multicam)) return
    ok(dispatch('multicam.switch', { frame: f, angle: n }))
  },

  // ── Reading the footage ──

  /** Splits the selected video clip (or the one under the playhead) where its shots change — or marks them. */
  async detectScenes(action: 'split' | 'markers' = 'split') {
    const clip = targetClips(['video']).find((c) => c.assetId)
    if (!clip) return void toast('Select a video clip first')
    try {
      const r = await withProgress('Finding scene cuts', (onProgress, signal) => scenesInClip(clip.id, { action }, onProgress, signal))
      if (!r.cuts.length) toast('No scene cuts found in that clip')
      else toast.success(`${action === 'split' ? 'Split at' : 'Marked'} ${plural(r.cuts.length, 'scene cut')}`)
    } catch (err) {
      if (!(err instanceof AnalysisCancelled)) toast.error('Scene detection failed', { description: err instanceof Error ? err.message : String(err) })
    }
  },

  /** Smooths the camera shake out of the selected video clip. */
  async stabilize(clipId?: string) {
    const clip = clipId ? getProject().clips[clipId] : targetClips(['video']).find((c) => c.assetId)
    if (!clip) return void toast('Select a video clip first')
    try {
      const r = await withProgress('Stabilizing', (onProgress, signal) => stabilizeClip(clip.id, {}, onProgress, signal))
      toast.success('Stabilized', { description: r.zoom > 1.001 ? `Zoomed in ${Math.round((r.zoom - 1) * 100)}% to hide the moving edges.` : undefined })
    } catch (err) {
      if (!(err instanceof AnalysisCancelled)) toast.error('Couldn’t stabilize', { description: err instanceof Error ? err.message : String(err) })
    }
  },

  /** Starts placing a box on the preview for the selected clip (or its mask) to follow. */
  trackMotion(clipId?: string, maskId?: string) {
    const clip = clipId ? getProject().clips[clipId] : targetClips().find((c) => c.kind !== 'audio')
    if (!clip) return void toast('Select the clip that should follow something')
    const f = frame()
    if (f < clip.start || f >= clipEnd(clip)) return void toast('Put the playhead over the clip, on a frame where what it should follow is visible')
    if (!maskId && clip.kind === 'adjustment') return void toast('Adjustment layers don’t move — track one of their masks instead')
    playback.pause()
    ui().select([clip.id])
    ui().setTrackEdit({ clipId: clip.id, maskId, box: initialTrackBox(getProject(), clip, maskId, f) })
  },

  // ── In & out points ──

  markIn() {
    const f = frame()
    const r = getProject().range
    const end = projectDuration(getProject())
    const out = r && r.out > f ? r.out : Math.max(f + 1, end)
    dispatch('timeline.setRange', { range: { in: f, out } })
  },

  markOut() {
    const f = Math.max(1, frame())
    const r = getProject().range
    dispatch('timeline.setRange', { range: { in: r && r.in < f ? r.in : 0, out: f } })
  },

  /** Marks in and out around the selected clips. */
  markSelection() {
    const clips = ui().selection.map((id) => getProject().clips[id]).filter(Boolean)
    if (!clips.length) return
    dispatch('timeline.setRange', { range: { in: Math.min(...clips.map((c) => c.start)), out: Math.max(...clips.map(clipEnd)) } })
  },

  clearInOut() {
    if (getProject().range) dispatch('timeline.setRange', { range: null })
  },

  goToIn() {
    const r = getProject().range
    if (r) (playback.pause(), playback.seek(r.in))
  },

  goToOut() {
    const r = getProject().range
    if (r) (playback.pause(), playback.seek(Math.max(r.in, r.out - 1)))
  },

  /** Lift: clears the marked stretch on every unlocked track and leaves the gap. */
  lift() {
    const r = getProject().range
    if (!r) return void toast('Mark in (I) and out (O) first')
    ok(dispatch('timeline.liftRange', { start: r.in, end: r.out }))
  },

  /** Extract: takes the marked stretch out and closes the gap. */
  extract() {
    const r = getProject().range
    if (!r) return void toast('Mark in (I) and out (O) first')
    if (ok(dispatch('timeline.removeRange', { start: r.in, end: r.out }, { label: 'Extract' }))) playback.seek(r.in)
  },

  playInToOut() {
    playback.playInToOut()
  },

  setTool(tool: Tool) {
    ui().setTool(tool)
  },

  selectAll() {
    const locked = new Set(getProject().tracks.filter((t) => t.locked).map((t) => t.id))
    ui().select(Object.values(getProject().clips).filter((c) => !locked.has(c.trackId)).map((c) => c.id))
  },

  addMarker() {
    dispatch('marker.add', { frame: frame() })
  },

  zoom(factor: number) {
    ui().setZoom(ui().pxPerSecond * factor)
  },

  zoomToFit() {
    ui().requestFit()
  },

  goToStart() {
    playback.pause()
    playback.seek(0)
  },

  goToEnd() {
    playback.pause()
    playback.seek(projectDuration(getProject()))
  },

  /** Moves the playhead by whole seconds at the project frame rate. */
  stepSeconds(seconds: number) {
    playback.step(Math.round(seconds * getProject().settings.fps))
  },

  jumpEdit(direction: 1 | -1) {
    const f = frame()
    const points = editPoints(getProject())
    const target = direction > 0 ? points.find((p) => p > f) : [...points].reverse().find((p) => p < f)
    if (target !== undefined) {
      playback.pause()
      playback.seek(target)
    }
  },

  importMedia() {
    void pickAndImport()
  },

  /** Files dropped from the OS (media panel, timeline). */
  importFileList(files: File[]) {
    return importDropped(files)
  },

  async save() {
    if (await saveProject()) toast.success('Project saved')
  },

  saveAs() {
    void saveProjectAs()
  },

  open() {
    void openProject()
  },

  /** The start screen, to begin a new project or open another. */
  home() {
    showHome(true)
  },

  toggleCopilot() {
    ui().setRightTab(ui().rightTab === 'copilot' ? 'inspector' : 'copilot')
  },
}
