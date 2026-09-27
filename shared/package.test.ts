import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { description: string }

describe('package.json', () => {
  it('keeps the description short enough for Windows shortcuts', () => {
    // The installer writes it into the Start menu and desktop shortcuts as their comment. Past 260
    // characters it overruns into the shortcut's icon path, and Windows shows a blank icon for Lumen.
    expect(pkg.description.length).toBeLessThanOrEqual(200)
  })
})
