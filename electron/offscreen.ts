import { BrowserWindow, screen, type BrowserWindowConstructorOptions } from 'electron'

/**
 * Offscreen windows that render pages at an exact pixel size, whatever the
 * display's scaling. Windows can't be larger than the screen's work area in
 * scaled pixels — at 125%, a "1920×1080" window is really about 1536×824 — so
 * a composition laid out for 1920×1080 used to render cropped and off centre.
 * Instead the window is made k times smaller, renders at a device scale of k,
 * and the page is zoomed by 1/k: the page sees exactly width×height CSS pixels
 * and the capture is exactly width×height pixels, on any display.
 */

/** Chromium's smallest page zoom is 25%, so a window can be at most 4× smaller than what it renders. */
const MAX_K = 4

/** The scale-down for rendering `width`×`height` within the largest work area on this computer. */
export function renderScale(width: number, height: number) {
  const area = screen
    .getAllDisplays()
    .map((d) => d.workAreaSize)
    .reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a), { width: 0, height: 0 })
  // A little margin: window frames and rounding never push it over.
  const k = Math.ceil(Math.max(1, width / Math.max(320, area.width - 16), height / Math.max(240, area.height - 16)))
  return Math.min(MAX_K, k)
}

/**
 * A hidden offscreen window whose page is exactly `width`×`height` CSS pixels and
 * captures at exactly that many pixels. `zoomFactor` and `offscreen` in `options`
 * are set here.
 */
export function exactOffscreenWindow(width: number, height: number, options: BrowserWindowConstructorOptions & { maxHeight?: number } = {}) {
  const { maxHeight, webPreferences, ...rest } = options
  // Room for the tallest the window will become (full-page screenshots grow after loading).
  const k = renderScale(width, Math.max(height, maxHeight ?? 0))
  const win = new BrowserWindow({
    ...rest,
    show: false,
    width: Math.ceil(width / k),
    height: Math.ceil(height / k),
    useContentSize: true,
    paintWhenInitiallyHidden: true,
    webPreferences: { ...webPreferences, offscreen: { deviceScaleFactor: k }, zoomFactor: 1 / k },
  })
  return { win, k, resize: (w: number, h: number) => win.setContentSize(Math.ceil(w / k), Math.ceil(h / k)) }
}
