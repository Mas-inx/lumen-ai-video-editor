import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { useEditor } from './store'

export type LeftTab = 'media' | 'audio' | 'text' | 'effects' | 'transitions' | 'looks' | 'generate'
export type RightTab = 'inspector' | 'mixer' | 'copilot'
/** select: move and trim · blade: cut · roll: move a cut · slip: change the footage in place · slide: move a clip between its neighbours */
export type Tool = 'select' | 'blade' | 'roll' | 'slip' | 'slide'
export type SelectMode = 'replace' | 'toggle' | 'add'

export const ZOOM_MIN = 6
export const ZOOM_MAX = 720

interface UIState {
  leftTab: LeftTab
  rightTab: RightTab
  tool: Tool
  snapping: boolean
  /** Timeline zoom */
  pxPerSecond: number
  selection: string[]
  showGuides: boolean
  /** The preview plays proxies where there are some. */
  useProxies: boolean
  /** Make proxies for 4K footage automatically. */
  autoProxies: boolean
  /** The preview gizmo edits the selected clip's crop instead of its transform. */
  cropMode: boolean
  /** The mask being edited on the canvas (on the selected clip). */
  maskEdit: string | null
  pasteAttributesOpen: boolean
  versionsOpen: boolean
  paletteOpen: boolean
  exportOpen: boolean
  shortcutsOpen: boolean
  aboutOpen: boolean
  /** clipId → timestamp; drives the "AI just touched this" shimmer */
  aiTouched: Record<string, number>
  /** Bumps to ask the timeline to zoom-to-fit */
  fitRequest: number

  setLeftTab: (tab: LeftTab) => void
  setRightTab: (tab: RightTab) => void
  setTool: (tool: Tool) => void
  toggleSnapping: () => void
  setZoom: (pxPerSecond: number) => void
  select: (ids: string[], mode?: SelectMode) => void
  clearSelection: () => void
  setShowGuides: (v: boolean) => void
  setUseProxies: (v: boolean) => void
  setAutoProxies: (v: boolean) => void
  setCropMode: (v: boolean) => void
  setMaskEdit: (id: string | null) => void
  setPasteAttributesOpen: (v: boolean) => void
  setVersionsOpen: (v: boolean) => void
  setPaletteOpen: (v: boolean) => void
  setExportOpen: (v: boolean) => void
  setShortcutsOpen: (v: boolean) => void
  setAboutOpen: (v: boolean) => void
  markAiTouched: (ids: string[]) => void
  requestFit: () => void
}

export const useUI = create<UIState>()(
  persist(
    (set) => ({
      leftTab: 'media',
      rightTab: 'inspector',
      tool: 'select',
      snapping: true,
      pxPerSecond: 36,
      selection: [],
      showGuides: false,
      useProxies: true,
      autoProxies: true,
      cropMode: false,
      maskEdit: null,
      pasteAttributesOpen: false,
      versionsOpen: false,
      paletteOpen: false,
      exportOpen: false,
      shortcutsOpen: false,
      aboutOpen: false,
      aiTouched: {},
      fitRequest: 0,

      setLeftTab: (leftTab) => set({ leftTab }),
      setRightTab: (rightTab) => set({ rightTab }),
      setTool: (tool) => set({ tool }),
      toggleSnapping: () => set((s) => ({ snapping: !s.snapping })),
      setZoom: (px) => set({ pxPerSecond: Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, px)) }),
      select: (ids, mode = 'replace') =>
        set((s) => {
          if (mode === 'replace') return { selection: ids }
          if (mode === 'add') return { selection: [...new Set([...s.selection, ...ids])] }
          const next = new Set(s.selection)
          for (const id of ids) {
            if (next.has(id)) next.delete(id)
            else next.add(id)
          }
          return { selection: [...next] }
        }),
      clearSelection: () => set({ selection: [] }),
      setShowGuides: (showGuides) => set({ showGuides }),
      setUseProxies: (useProxies) => set({ useProxies }),
      setAutoProxies: (autoProxies) => set({ autoProxies }),
      setCropMode: (cropMode) => set({ cropMode, ...(cropMode ? { maskEdit: null } : {}) }),
      setMaskEdit: (maskEdit) => set({ maskEdit, ...(maskEdit ? { cropMode: false } : {}) }),
      setPasteAttributesOpen: (pasteAttributesOpen) => set({ pasteAttributesOpen }),
      setVersionsOpen: (versionsOpen) => set({ versionsOpen }),
      setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
      setExportOpen: (exportOpen) => set({ exportOpen }),
      setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
      setAboutOpen: (aboutOpen) => set({ aboutOpen }),
      markAiTouched: (ids) =>
        set((s) => {
          const now = Date.now()
          const next = { ...s.aiTouched }
          for (const id of ids) next[id] = now
          return { aiTouched: next }
        }),
      requestFit: () => set((s) => ({ fitRequest: s.fitRequest + 1 })),
    }),
    {
      name: 'lumen.ui.v1',
      partialize: (s) => ({
        leftTab: s.leftTab,
        rightTab: s.rightTab,
        snapping: s.snapping,
        pxPerSecond: s.pxPerSecond,
        showGuides: s.showGuides,
        useProxies: s.useProxies,
        autoProxies: s.autoProxies,
      }),
    },
  ),
)

// Keep the selection honest when clips disappear (undo, delete, AI edits).
useEditor.subscribe((state, prev) => {
  if (state.project.clips === prev.project.clips) return
  const { selection } = useUI.getState()
  const alive = selection.filter((id) => state.project.clips[id])
  if (alive.length !== selection.length) useUI.setState({ selection: alive })
})

// Crop and mask editing belong to one clip: selecting something else leaves them.
useUI.subscribe((state, prev) => {
  if ((state.cropMode || state.maskEdit) && state.selection !== prev.selection) useUI.setState({ cropMode: false, maskEdit: null })
})
