/**
 * Selecting media in the Media panel: click, Ctrl/⌘-click to toggle,
 * Shift-click for a range, drag a box around cards, Ctrl/⌘+A for everything
 * shown. Bulk actions (add, favorite, proxies, transcripts, remove) work on it.
 */
import { toast } from 'sonner'
import { create } from 'zustand'
import { clipEnd } from '@/editor/ops'
import { placeAsset } from '@/editor/placement'
import { usePlayback } from '@/editor/playback'
import { dispatch, getProject, useEditor } from '@/editor/store'
import { useUI } from '@/editor/ui-store'

interface MediaSelection {
  ids: string[]
  /** Where Shift-click ranges start. */
  anchor: string | null
}

export const useMediaSelection = create<MediaSelection>(() => ({ ids: [], anchor: null }))

export type PickMode = 'replace' | 'toggle' | 'range'

/** Selects `id` (in `order`, the media as shown) the way a click with those modifiers does. */
export function pickMedia(id: string, mode: PickMode, order: string[]) {
  const { ids, anchor } = useMediaSelection.getState()
  if (mode === 'toggle') {
    useMediaSelection.setState({ ids: ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id], anchor: id })
    return
  }
  if (mode === 'range' && anchor && order.includes(anchor) && order.includes(id)) {
    const a = order.indexOf(anchor)
    const b = order.indexOf(id)
    useMediaSelection.setState({ ids: order.slice(Math.min(a, b), Math.max(a, b) + 1) })
    return
  }
  useMediaSelection.setState({ ids: [id], anchor: id })
}

export const setMediaSelection = (ids: string[]) => useMediaSelection.setState({ ids, anchor: ids.at(-1) ?? null })
export const clearMediaSelection = () => useMediaSelection.setState({ ids: [], anchor: null })

/** Adds media one after another, starting at the playhead (on the tracks they belong on). */
export function addMediaAtPlayhead(ids: string[]) {
  let at = usePlayback.getState().frame
  const placed: string[] = []
  useEditor.getState().transaction(ids.length > 1 ? `Add ${ids.length} clips` : 'Add clip', 'user', () => {
    for (const id of ids) {
      const clipId = placeAsset(id, at)
      if (!clipId) continue
      placed.push(clipId)
      at = clipEnd(getProject().clips[clipId])
    }
  })
  if (placed.length) useUI.getState().select(placed)
  return placed
}

/** Removes media from the project, with the clips that use it — undoable from the toast. */
export function removeMedia(ids: string[]) {
  if (!ids.length) return
  const project = getProject()
  const set = new Set(ids)
  const clips = Object.values(project.clips).filter((c) => c.assetId && set.has(c.assetId)).length
  const res = dispatch('asset.remove', { ids })
  if (!res.ok) return void toast.error(res.error)
  clearMediaSelection()
  const what = `${ids.length} media item${ids.length === 1 ? '' : 's'}`
  toast(`Removed ${what}${clips ? ` and ${clips} clip${clips === 1 ? '' : 's'} using ${ids.length === 1 ? 'it' : 'them'}` : ''}`, {
    action: { label: 'Undo', onClick: () => useEditor.getState().undo() },
  })
}

/** Favorites them all — or, when they already all are, un-favorites them. */
export function toggleFavorite(ids: string[]) {
  const assets = getProject().assets
  const all = ids.every((id) => assets[id]?.favorite)
  useEditor.getState().transaction(all ? 'Remove from favorites' : 'Add to favorites', 'user', () => {
    for (const id of ids) if (assets[id]) dispatch('asset.update', { id, patch: { favorite: !all } })
  })
}

// Media that's gone (removed, undone, another project) leaves the selection.
useEditor.subscribe((s, prev) => {
  if (s.project.id !== prev.project.id) return clearMediaSelection()
  if (s.project.assets === prev.project.assets) return
  const { ids } = useMediaSelection.getState()
  const alive = ids.filter((id) => s.project.assets[id])
  if (alive.length !== ids.length) useMediaSelection.setState({ ids: alive })
})
