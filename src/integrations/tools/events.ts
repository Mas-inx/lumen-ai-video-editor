import type { ToolImage } from './kit'

/**
 * What tools tell the UI while and after they run, whichever brain asked: the
 * pictures an AI looked at (frames, contact sheets, screenshots), and how a long
 * job is getting on.
 */
type ImageListener = (tool: string, images: ToolImage[]) => void
type ProgressListener = (tool: string, message: string) => void

const imageListeners = new Set<ImageListener>()
const progressListeners = new Set<ProgressListener>()

export function onToolImages(fn: ImageListener) {
  imageListeners.add(fn)
  return () => void imageListeners.delete(fn)
}

export function emitToolImages(tool: string, images: ToolImage[]) {
  for (const fn of imageListeners) fn(tool, images)
}

/** A line about what a running tool is doing right now ("45% — frame 120 of 260"). */
export function onToolProgress(fn: ProgressListener) {
  progressListeners.add(fn)
  return () => void progressListeners.delete(fn)
}

export function emitToolProgress(tool: string, message: string) {
  for (const fn of progressListeners) fn(tool, message)
}
