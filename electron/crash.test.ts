import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({
  root: '',
  /** Answers the next dialogs get (button index), or a promise for one. */
  answers: [] as (number | Promise<number>)[],
  asked: [] as { message: string; buttons: string[]; signal?: AbortSignal }[],
  quit: 0,
}))

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => path.join(env.root, name),
    getVersion: () => '1.0.0',
    addRecentDocument: () => {},
    on: () => {},
    quit: () => void env.quit++,
  },
  dialog: {
    showMessageBox: async (_win: unknown, opts: { message: string; buttons: string[]; signal?: AbortSignal }) => {
      env.asked.push(opts)
      return { response: await (env.answers.shift() ?? 0) }
    },
  },
  BrowserWindow: class {},
  net: {},
  protocol: {},
  shell: {},
}))

env.root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-crash-test-'))
const { QUICK_STOP_MS, crashOffer, restarted, steadyGuard, watchEditor } = await import('./crash')
const { setProjectState, takeReopen, writeRecovery } = await import('./project')

afterAll(() => fs.rmSync(env.root, { recursive: true, force: true }))

/** An editor window, as far as crash handling sees it. */
function editorWindow() {
  const webContents = Object.assign(new EventEmitter(), {
    reloads: 0,
    killed: 0,
    reload() {
      this.reloads++
    },
    forcefullyCrashRenderer() {
      this.killed++
    },
    isCrashed: () => false,
  })
  const win = {
    webContents,
    destroyed: false,
    isDestroyed() {
      return this.destroyed
    },
    destroy() {
      this.destroyed = true
    },
    setTitle() {},
    setDocumentEdited() {},
    setRepresentedFilename() {},
  }
  let released = 0
  watchEditor(win as never, () => void released++)
  return { win, webContents, released: () => released }
}

const settle = () => new Promise((r) => setTimeout(r, 0))
const crash = (w: ReturnType<typeof editorWindow>, reason = 'crashed') => w.webContents.emit('render-process-gone', {}, { reason, exitCode: 1 })

let clock = 1_000_000
vi.spyOn(Date, 'now').mockImplementation(() => clock)

beforeEach(() => {
  env.answers = []
  env.asked = []
  env.quit = 0
  clock += 60 * 60_000
  takeReopen()
})

describe('the crash-loop guard', () => {
  it('offers to reload, then to start without the project, then only to quit, when the editor keeps stopping soon after coming back', () => {
    let guard = steadyGuard()
    expect(crashOffer(guard, 0)).toBe('reload')
    guard = restarted('reload', 1000)
    expect(crashOffer(guard, 1000 + QUICK_STOP_MS - 1)).toBe('without-project')
    guard = restarted('without-project', 2000)
    expect(crashOffer(guard, 2000 + 30_000)).toBe('quit')
    expect(crashOffer(restarted('quit', 3000), 3001)).toBe('quit')
  })

  it('starts over once the editor has run a while', () => {
    expect(crashOffer(restarted('without-project', 0), QUICK_STOP_MS)).toBe('reload')
  })
})

describe('when the editor stops', () => {
  it('reloads onto the recovery copy when it holds the project’s unsaved changes', async () => {
    const w = editorWindow()
    setProjectState(w.win as never, { id: 'proj_1', name: 'Show', path: 'C:/Show.lumen', dirty: true })
    writeRecovery({ text: JSON.stringify({ id: 'proj_1', name: 'Show', assets: {} }), path: 'C:/Show.lumen', name: 'Show' })
    env.answers.push(0)
    crash(w, 'oom')
    await settle()
    expect(env.asked).toHaveLength(1)
    expect(env.asked[0].message).toMatch(/ran out of memory/)
    expect(env.asked[0].buttons).toEqual(['Reload', 'Quit'])
    expect(w.released()).toBe(1)
    expect(w.webContents.reloads).toBe(1)
    expect(takeReopen()).toEqual({ path: 'C:/Show.lumen', recover: true })
    // Taken once: a later, ordinary start doesn't reopen anything.
    expect(takeReopen()).toBeNull()
  })

  it('reopens the project’s file when the recovery copy is another project’s', async () => {
    const w = editorWindow()
    setProjectState(w.win as never, { id: 'proj_2', name: 'Other', path: 'C:/Other.lumen', dirty: true })
    writeRecovery({ text: JSON.stringify({ id: 'proj_1', name: 'Show', assets: {} }), path: 'C:/Show.lumen', name: 'Show' })
    env.answers.push(0)
    crash(w)
    await settle()
    expect(takeReopen()).toEqual({ path: 'C:/Other.lumen', recover: false })
  })

  it('steps down when it stops again soon after, and never loops', async () => {
    const w = editorWindow()
    setProjectState(w.win as never, { id: 'proj_3', name: 'Heavy', path: 'C:/Heavy.lumen', dirty: false })
    env.answers.push(0, 0, 0)
    crash(w)
    await settle()
    expect(takeReopen()).toEqual({ path: 'C:/Heavy.lumen', recover: false })
    clock += 20_000
    crash(w)
    await settle()
    expect(env.asked[1].buttons).toEqual(['Start without the project', 'Quit'])
    expect(w.webContents.reloads).toBe(2)
    // Started on the start screen this time.
    expect(takeReopen()).toBeNull()
    clock += 20_000
    crash(w)
    await settle()
    expect(env.asked[2].buttons).toEqual(['Quit'])
    expect(w.webContents.reloads).toBe(2)
    expect(w.win.destroyed).toBe(true)
    expect(env.quit).toBe(1)
  })

  it('ignores a page that exited cleanly', async () => {
    const w = editorWindow()
    crash(w, 'clean-exit')
    await settle()
    expect(env.asked).toHaveLength(0)
    expect(w.released()).toBe(0)
  })

  it('quits without asking to save when the user chooses to', async () => {
    const w = editorWindow()
    env.answers.push(1)
    crash(w)
    await settle()
    expect(w.webContents.reloads).toBe(0)
    expect(w.win.destroyed).toBe(true)
    expect(env.quit).toBe(1)
  })
})

describe('when the editor hangs', () => {
  it('can wait, or end the page and reload it without asking again', async () => {
    const w = editorWindow()
    setProjectState(w.win as never, { id: 'proj_4', name: 'Busy', path: 'C:/Busy.lumen', dirty: false })
    env.answers.push(0)
    w.webContents.emit('unresponsive')
    await settle()
    expect(env.asked[0].buttons).toEqual(['Wait', 'Reload', 'Quit'])
    expect(w.webContents.killed).toBe(0)
    expect(w.webContents.reloads).toBe(0)
    env.answers.push(1)
    w.webContents.emit('unresponsive')
    await settle()
    expect(w.webContents.killed).toBe(1)
    expect(w.webContents.reloads).toBe(1)
    expect(takeReopen()).toEqual({ path: 'C:/Busy.lumen', recover: false })
    // The page it ended goes without a second dialog.
    crash(w, 'killed')
    await settle()
    expect(env.asked).toHaveLength(2)
  })

  it('closes the dialog by itself if the page answers again', async () => {
    const w = editorWindow()
    let answer: (n: number) => void = () => {}
    env.answers.push(new Promise<number>((r) => (answer = r)))
    w.webContents.emit('unresponsive')
    await settle()
    const signal = env.asked[0].signal!
    w.webContents.emit('responsive')
    expect(signal.aborted).toBe(true)
    // Electron then answers as if cancelled; nothing happens.
    answer(1)
    await settle()
    expect(w.webContents.reloads).toBe(0)
    expect(w.webContents.killed).toBe(0)
  })
})
