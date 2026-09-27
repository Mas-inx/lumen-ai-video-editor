import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getVersion: () => '1.0.2', isPackaged: false } }))
vi.mock('electron-updater', () => ({ default: { autoUpdater: {} } }))

const { friendly, notesOf, updateState } = await import('./updater')

describe('updater', () => {
  it('starts idle on the running version', () => {
    expect(updateState()).toEqual({ status: 'idle', current: '1.0.2' })
  })

  it('turns GitHub’s HTML release notes into text', () => {
    const html = '<h2>Lumen 1.1.0 — effort &amp; models</h2><ul><li>OpenCode Go</li><li>Pick an <code>effort</code></li></ul><p>Thanks!</p>'
    expect(notesOf({ releaseNotes: html })).toBe('Lumen 1.1.0 — effort & models\nOpenCode Go\nPick an effort\nThanks!')
    expect(notesOf({ releaseNotes: [{ version: '1.1.0', note: '<p>One</p>' }, { version: '1.0.9', note: 'Two' }] })).toBe('One\n\nTwo')
    expect(notesOf({ releaseNotes: null })).toBeUndefined()
    expect(notesOf({ releaseNotes: '<p> </p>' })).toBeUndefined()
  })

  it('explains the usual failures in plain words', () => {
    expect(friendly(new Error('net::ERR_INTERNET_DISCONNECTED'))).toMatch(/connection/)
    expect(friendly(new Error('Cannot find latest.yml in the latest release artifacts (https://github.com/…): HttpError: 404'))).toMatch(/no update for this version yet/)
    expect(friendly(new Error('sha512 checksum mismatch, expected abc, got def'))).toMatch(/checksum/)
    expect(friendly(new Error('Something odd\nwith a stack'))).toBe('Something odd')
  })
})
