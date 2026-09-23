/**
 * App-level actions shared by keyboard shortcuts, menus, the command palette
 * and toolbar buttons — one implementation, many entry points.
 */
import { toast } from 'sonner'
import { clipsAt, editPoints, projectDuration } from '@/editor/ops'
import { playback, usePlayback } from '@/editor/playback'
import { dispatch, getProject, useEditor } from '@/editor/store'
import { useUI } from '@/editor/ui-store'
import { importDropped, pickAndImport } from '@/project/media-import'
import { openProject, saveProject, saveProjectAs, showHome } from '@/project/session'

const ui = () => useUI.getState()
const frame = () => usePlayback.getState().frame

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
