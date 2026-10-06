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

/** How much of the viewer's resolution the preview renders: 1 = full, 0.5 = half… Auto adapts while playing. */
export type PreviewRes = 'auto' | 1 | 0.5 | 0.25 | 0.125
export const PREVIEW_RES: { value: PreviewRes; label: string; hint: string }[] = [
  { value: 'auto', label: 'Auto', hint: 'Full resolution, stepping down while playing when this computer can’t keep up' },
  { value: 1, label: 'Full', hint: 'Every pixel of the viewer' },
  { value: 0.5, label: '1/2', hint: 'Half resolution — about four times less work' },
  { value: 0.25, label: '1/4', hint: 'Quarter resolution — for heavy effects on slower computers' },
  { value: 0.125, label: '1/8', hint: 'Draft — the lightest preview' },
]

/** Render previews' resolution, as a fraction of the project's. */
export type RenderRes = 1 | 0.5 | 0.25 | 0.125
export const RENDER_RES: { value: RenderRes; label: string; hint: string }[] = [
  { value: 1, label: 'Full', hint: 'Every pixel — the slowest to render and the largest files' },
  { value: 0.5, label: '1/2', hint: 'Half resolution, upscaled on playback — the best balance' },
  { value: 0.25, label: '1/4', hint: 'Quarter resolution — renders four times faster than 1/2' },
  { value: 0.125, label: '1/8', hint: 'Draft — renders in moments' },
]

/** How lower-resolution pictures (previews, renders) are scaled up to the viewer. */
export type Upscale = 'sharp' | 'smooth'

/** The box being placed to track motion, in project pixels (top-left based) at the playhead. */
export interface TrackEdit {
  clipId: string
  /** Track one of the clip's masks rather than the clip itself. */
  maskId?: string
  /** The clip is the footage itself: what is boxed in it gets a new title pinned to it. */
  newTitle?: boolean
  box: { x: number; y: number; w: number; h: number }
}

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
  /** Preview resolution while playing (Auto steps down on a slow computer). */
  playbackRes: PreviewRes
  /** Preview resolution while paused and scrubbing. */
  pausedRes: Exclude<PreviewRes, 'auto'>
  /** Make proxies for 4K footage automatically. */
  autoProxies: boolean
  /** Render previews' resolution. */
  renderRes: RenderRes
  /** Scaling lower-resolution pictures up: sharp (contrast-adaptive sharpening on the GPU) or smooth. */
  upscale: Upscale
  /** Render stretches that need it while the editor sits idle. */
  backgroundRender: boolean
  /** Play rendered previews where there are some (instead of compositing live). */
  usePreviews: boolean
  /** The preview gizmo edits the selected clip's crop instead of its transform. */
  cropMode: boolean
  /** The mask being edited on the canvas (on the selected clip). */
  maskEdit: string | null
  pasteAttributesOpen: boolean
  versionsOpen: boolean
  queueOpen: boolean
  /** The multicam dialog, with the media it starts from. */
  multicam: { assetIds: string[] } | null
  /** The camera-angle strip under the preview (for multicam clips). */
  angleViewer: boolean
  /** Placing a box to track motion (hides the other gizmos). */
  trackEdit: TrackEdit | null
  /** A timeline being renamed. */
  renamingTimeline: string | null
  paletteOpen: boolean
  exportOpen: boolean
  shortcutsOpen: boolean
  aboutOpen: boolean
  /** The graphics card and encoder check. */
  graphicsOpen: boolean
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
  setPlaybackRes: (v: PreviewRes) => void
  setPausedRes: (v: Exclude<PreviewRes, 'auto'>) => void
  setAutoProxies: (v: boolean) => void
  setRenderRes: (v: RenderRes) => void
  setUpscale: (v: Upscale) => void
  setBackgroundRender: (v: boolean) => void
  setUsePreviews: (v: boolean) => void
  setCropMode: (v: boolean) => void
  setMaskEdit: (id: string | null) => void
  setPasteAttributesOpen: (v: boolean) => void
  setVersionsOpen: (v: boolean) => void
  setQueueOpen: (v: boolean) => void
  setMulticam: (v: { assetIds: string[] } | null) => void
  setAngleViewer: (v: boolean) => void
  setTrackEdit: (v: TrackEdit | null) => void
  setRenamingTimeline: (id: string | null) => void
  setPaletteOpen: (v: boolean) => void
  setExportOpen: (v: boolean) => void
  setShortcutsOpen: (v: boolean) => void
  setAboutOpen: (v: boolean) => void
  setGraphicsOpen: (v: boolean) => void
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
      playbackRes: 'auto',
      pausedRes: 1,
      autoProxies: true,
      renderRes: 0.5,
      upscale: 'sharp',
      backgroundRender: true,
      usePreviews: true,
      cropMode: false,
      maskEdit: null,
      pasteAttributesOpen: false,
      versionsOpen: false,
      queueOpen: false,
      multicam: null,
      angleViewer: true,
      trackEdit: null,
      renamingTimeline: null,
      paletteOpen: false,
      exportOpen: false,
      shortcutsOpen: false,
      aboutOpen: false,
      graphicsOpen: false,
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
      setPlaybackRes: (playbackRes) => set({ playbackRes }),
      setPausedRes: (pausedRes) => set({ pausedRes }),
      setAutoProxies: (autoProxies) => set({ autoProxies }),
      setRenderRes: (renderRes) => set({ renderRes }),
      setUpscale: (upscale) => set({ upscale }),
      setBackgroundRender: (backgroundRender) => set({ backgroundRender }),
      setUsePreviews: (usePreviews) => set({ usePreviews }),
      setCropMode: (cropMode) => set({ cropMode, ...(cropMode ? { maskEdit: null } : {}) }),
      setMaskEdit: (maskEdit) => set({ maskEdit, ...(maskEdit ? { cropMode: false } : {}) }),
      setPasteAttributesOpen: (pasteAttributesOpen) => set({ pasteAttributesOpen }),
      setVersionsOpen: (versionsOpen) => set({ versionsOpen }),
      setQueueOpen: (queueOpen) => set({ queueOpen }),
      setMulticam: (multicam) => set({ multicam }),
      setAngleViewer: (angleViewer) => set({ angleViewer }),
      setTrackEdit: (trackEdit) => set({ trackEdit, ...(trackEdit ? { cropMode: false, maskEdit: null } : {}) }),
      setRenamingTimeline: (renamingTimeline) => set({ renamingTimeline }),
      setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
      setExportOpen: (exportOpen) => set({ exportOpen }),
      setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
      setAboutOpen: (aboutOpen) => set({ aboutOpen }),
      setGraphicsOpen: (graphicsOpen) => set({ graphicsOpen }),
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
        playbackRes: s.playbackRes,
        pausedRes: s.pausedRes,
        autoProxies: s.autoProxies,
        renderRes: s.renderRes,
        upscale: s.upscale,
        backgroundRender: s.backgroundRender,
        usePreviews: s.usePreviews,
        angleViewer: s.angleViewer,
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

// Crop, mask and tracking-box editing belong to one clip: selecting something else leaves them.
useUI.subscribe((state, prev) => {
  if ((state.cropMode || state.maskEdit || state.trackEdit) && state.selection !== prev.selection) useUI.setState({ cropMode: false, maskEdit: null, trackEdit: null })
})
