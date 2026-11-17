import { app, dialog, type BrowserWindow, type MessageBoxOptions, type RenderProcessGoneDetails } from 'electron'
import { holdReopen, projectStatus } from './project'

/**
 * When the editor's page dies (it crashed, or ran out of memory) or stops
 * answering, a native dialog offers to reload it — back onto the project, with
 * the changes autosaved for recovery — or to quit, instead of leaving a black
 * window. Stopping again soon after a reload offers to start without the
 * project instead, and a third time only to quit: a project that brings the
 * editor down can't trap it in a loop.
 */

/** A stop this soon after the editor was brought back counts as the same trouble again. */
export const QUICK_STOP_MS = 2 * 60_000

/** reload: back onto the project · without-project: the start screen · quit: nothing else. */
export type CrashOffer = 'reload' | 'without-project' | 'quit'
const OFFERS: CrashOffer[] = ['reload', 'without-project', 'quit']

/** How the editor has been doing this run: what it was last brought back with, and when. */
export interface CrashGuard {
  /** Index in OFFERS of the way it was last brought back. */
  level: number
  restartedAt: number | null
}

export const steadyGuard = (): CrashGuard => ({ level: 0, restartedAt: null })

/** What to offer when the editor stops at `now`: one step further down each time it stops soon after coming back. */
export function crashOffer(guard: CrashGuard, now: number): CrashOffer {
  const quick = guard.restartedAt !== null && now - guard.restartedAt < QUICK_STOP_MS
  return OFFERS[quick ? Math.min(guard.level + 1, OFFERS.length - 1) : 0]
}

/** The guard after the editor was brought back at `now` with `offer`. */
export const restarted = (offer: CrashOffer, now: number): CrashGuard => ({ level: OFFERS.indexOf(offer), restartedAt: now })

type Choice = 'wait' | 'reload' | 'without-project' | 'quit'

const quote = (name: string) => `“${name}”`

/** The dialog for an editor that's gone (`reason`) or hung, and what each of its buttons does. */
export function crashDialog(kind: 'gone' | 'hung', offer: CrashOffer, project: { name: string; path: string | null; dirty: boolean }, reason?: RenderProcessGoneDetails['reason']) {
  const saved = project.dirty ? ' Your changes up to a few seconds ago were saved.' : ''
  const kept = project.dirty ? ' Your unsaved changes stay ready to recover on the start screen.' : ''
  const choices: Choice[] = [...(kind === 'hung' ? (['wait'] as const) : []), ...(offer === 'quit' ? [] : [offer]), 'quit']
  const label: Record<Choice, string> = { wait: 'Wait', reload: 'Reload', 'without-project': 'Start without the project', quit: 'Quit' }
  let message: string
  let detail: string
  if (kind === 'hung') {
    message = 'Lumen’s editor isn’t responding'
    detail = `It may be busy with something heavy: wait for it, or ${offer === 'quit' ? 'quit' : offer === 'reload' ? 'reload it' : 'start again without the project'}.${saved}`
  } else if (offer === 'reload') {
    message = reason === 'oom' || reason === 'memory-eviction' ? 'Lumen’s editor ran out of memory' : 'Lumen’s editor stopped working'
    const lands = project.dirty ? 'opens the project again with them' : project.path ? `opens ${quote(project.name)} again` : 'starts the editor again'
    detail = `${saved} Reload ${lands}.`.trim()
  } else if (offer === 'without-project') {
    message = 'Lumen’s editor stopped again'
    detail = `It stopped soon after reloading, so it may be something in ${quote(project.name)}. Start without the project.${kept}`
  } else {
    message = 'Lumen’s editor keeps stopping'
    detail = `Quit, then start Lumen again.${kept}`
  }
  const opts: MessageBoxOptions = {
    type: 'warning',
    title: 'Lumen',
    message,
    detail,
    buttons: choices.map((c) => label[c]),
    defaultId: kind === 'hung' ? 0 : Math.max(0, choices.length - 2),
    cancelId: kind === 'hung' ? 0 : choices.length - 1,
    noLink: true,
  }
  return { opts, choices }
}

/**
 * Watches the editor window's page. `release` lets go of what the dead page had
 * running in this process (exports being written, recordings' helpers).
 */
export function watchEditor(win: BrowserWindow, release: () => void) {
  let guard = steadyGuard()
  /** The open "isn't responding" dialog: closed if the page answers again, or dies. */
  let hang: AbortController | null = null
  let gone = false
  /** The page was ended on purpose (a hung page reloaded): its going needs no dialog. */
  let ending = false
  let quitting = false
  app.on('before-quit', () => {
    quitting = true
  })

  const act = (choice: Choice, offer: CrashOffer, kind: 'gone' | 'hung') => {
    if (choice === 'wait' || win.isDestroyed()) return
    if (kind === 'hung') {
      ending = true
      release()
      win.webContents.forcefullyCrashRenderer()
    }
    if (choice === 'quit') {
      // Straight away: a dead page can't answer "Save changes?". The recovery copy stays for next time.
      quitting = true
      win.destroy()
      app.quit()
      return
    }
    guard = restarted(offer, Date.now())
    holdReopen(choice === 'reload')
    win.webContents.reload()
  }

  const ask = async (kind: 'gone' | 'hung', reason?: RenderProcessGoneDetails['reason']) => {
    const offer = crashOffer(guard, Date.now())
    const { opts, choices } = crashDialog(kind, offer, projectStatus(), reason)
    const ctl = kind === 'hung' ? new AbortController() : null
    if (ctl) hang = ctl
    else gone = true
    let response: number
    try {
      ;({ response } = await dialog.showMessageBox(win, ctl ? { ...opts, signal: ctl.signal } : opts))
    } catch {
      // No dialog to be had: what it would have suggested (a hung page is waited for; the guard still steps down).
      response = opts.defaultId ?? 0
    } finally {
      if (ctl && hang === ctl) hang = null
      if (!ctl) gone = false
    }
    if (ctl?.signal.aborted || quitting) return
    act(choices[response] ?? 'quit', offer, kind)
  }

  win.webContents.on('render-process-gone', (_e, details) => {
    if (quitting || win.isDestroyed() || details.reason === 'clean-exit') return
    if (ending) {
      ending = false
      return
    }
    hang?.abort()
    release()
    if (!gone) void ask('gone', details.reason)
  })
  win.webContents.on('unresponsive', () => {
    if (quitting || win.isDestroyed() || hang || gone) return
    void ask('hung')
  })
  win.webContents.on('responsive', () => hang?.abort())
  // The page that was ended has been reported gone by now; a later stop is a stop.
  win.webContents.on('did-finish-load', () => {
    ending = false
  })
}
