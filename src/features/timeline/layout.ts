import { createContext, useContext } from 'react'
import type { Track } from '@/editor/types'
import { RULER_H } from './model'

export interface TimelineLayout {
  pps: number
  fps: number
  /** content-space top of each track row */
  rowTop: Record<string, number>
  rowHeight: Record<string, number>
  tracks: Track[]
}

export const LayoutContext = createContext<TimelineLayout | null>(null)

export function useLayout() {
  const ctx = useContext(LayoutContext)
  if (!ctx) throw new Error('Timeline layout missing')
  return ctx
}

export function computeRows(tracks: Track[]) {
  const rowTop: Record<string, number> = {}
  const rowHeight: Record<string, number> = {}
  let y = RULER_H
  for (const t of tracks) {
    rowTop[t.id] = y
    rowHeight[t.id] = t.height
    y += t.height
  }
  return { rowTop, rowHeight, bottom: y }
}

export const frameToPx = (frame: number, pps: number, fps: number) => (frame / fps) * pps
export const pxToFrame = (px: number, pps: number, fps: number) => Math.round((px / pps) * fps)
