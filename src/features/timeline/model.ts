import { create } from 'zustand'
import type { ClipKind } from '@/editor/types'

export const HEADER_W = 188
export const RULER_H = 30
export const ADD_ROW_H = 44
export const SNAP_PX = 8

export const CLIP_COLOR: Record<ClipKind, string> = {
  video: 'var(--color-clip-video)',
  image: 'var(--color-clip-image)',
  audio: 'var(--color-clip-audio)',
  text: 'var(--color-clip-text)',
  adjustment: 'var(--color-clip-adjust)',
}

export interface ClipPreview {
  start: number
  duration: number
  trackId: string
  inPoint: number
}

import type { TransitionSpot } from '@/editor/placement'

export interface DropGhost {
  trackId: string | null
  start: number
  duration: number
  label: string
  kind: ClipKind
}

interface DragState {
  mode: 'move' | 'trim' | 'marquee' | 'scrub' | 'fade' | 'keyframe' | null
  /** Clips under the pointer's direct control (others with previews are just making room). */
  dragIds: string[]
  /** Live positions of clips being moved/trimmed — and neighbours sliding out of the way */
  previews: Record<string, ClipPreview>
  snapFrame: number | null
  /** content-space rectangle */
  marquee: { x0: number; y0: number; x1: number; y1: number } | null
  /** floating readout near the pointer (content space) */
  readout: { x: number; y: number; text: string } | null
  bladeFrame: number | null
  dropGhost: DropGhost | null
  dropTargetClip: string | null
  /** A transition being dragged over a cut: the clip after the cut and where the transition would sit. */
  dropTransition: TransitionSpot | null
  /** Reordering tracks: the content-space y of the insertion line. */
  trackDropY: number | null
  /** A keyframe being dragged along its clip: where it was and where it would land (clip-relative frames). */
  keyDrag: { clipId: string; from: number; to: number } | null
}

export const useDrag = create<DragState>(() => ({
  mode: null,
  dragIds: [],
  previews: {},
  snapFrame: null,
  marquee: null,
  readout: null,
  bladeFrame: null,
  dropGhost: null,
  dropTargetClip: null,
  dropTransition: null,
  trackDropY: null,
  keyDrag: null,
}))

export const resetDrag = () =>
  useDrag.setState({ mode: null, dragIds: [], previews: {}, snapFrame: null, marquee: null, readout: null, keyDrag: null })

export const dbToGain = (db: number) => Math.pow(10, db / 20)
