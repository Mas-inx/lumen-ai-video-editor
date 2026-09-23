import type { ToolImage } from './kit'

/** Lets the UI show what an AI looked at (frames, contact sheets, screenshots), whichever brain asked. */
type Listener = (tool: string, images: ToolImage[]) => void

const listeners = new Set<Listener>()

export function onToolImages(fn: Listener) {
  listeners.add(fn)
  return () => void listeners.delete(fn)
}

export function emitToolImages(tool: string, images: ToolImage[]) {
  for (const fn of listeners) fn(tool, images)
}
