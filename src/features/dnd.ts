import type { DragEvent } from 'react'
import type { EffectKind, TransitionKind } from '@/editor/types'

/**
 * Drag & drop payloads between the asset browser and the timeline. The payload
 * is kept in memory during a drag because dataTransfer is unreadable in dragover.
 */
export type DragPayload =
  | { type: 'asset'; assetId: string }
  | { type: 'title'; presetId: string }
  | { type: 'effect'; kind: EffectKind }
  | { type: 'transition'; kind: TransitionKind }
  | { type: 'look'; lookId: string }
  | { type: 'sfx'; sfxId: string }

const MIME = 'application/x-lumen'
let current: DragPayload | null = null

export const dnd = {
  start(e: DragEvent, payload: DragPayload, label?: string) {
    current = payload
    e.dataTransfer.effectAllowed = 'copy'
    e.dataTransfer.setData(MIME, JSON.stringify(payload))
    e.dataTransfer.setData('text/plain', label ?? payload.type)
    if (label) setDragImage(e, label)
  },
  end() {
    current = null
  },
  get: () => current,
}

let ghost: HTMLDivElement | null = null

function setDragImage(e: DragEvent, label: string) {
  ghost?.remove()
  ghost = document.createElement('div')
  ghost.textContent = label
  Object.assign(ghost.style, {
    position: 'fixed',
    top: '-100px',
    left: '-100px',
    padding: '6px 12px',
    borderRadius: '8px',
    background: 'rgba(28,28,33,0.96)',
    color: '#ededf1',
    font: '500 12px "Geist Variable", sans-serif',
    boxShadow: '0 0 0 1px rgba(255,255,255,0.1), 0 12px 32px -8px rgba(0,0,0,0.8)',
    whiteSpace: 'nowrap',
  })
  document.body.appendChild(ghost)
  e.dataTransfer.setDragImage(ghost, 16, 16)
  setTimeout(() => ghost?.remove(), 0)
}
