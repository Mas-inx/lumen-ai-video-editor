import fs from 'node:fs'
import path from 'node:path'
import { safeStorage } from 'electron'
import { ensureDir, userDir } from './paths'

/**
 * API keys and other secrets, encrypted with the OS keychain (DPAPI on
 * Windows, Keychain on macOS, libsecret on Linux). They never leave the
 * main process; the editor only ever sees a hint like "…a1b2".
 */

const FILE = 'secrets.bin'
let cache: Record<string, string> | null = null

function load() {
  if (cache) return cache
  try {
    const buf = fs.readFileSync(path.join(userDir(), FILE))
    cache = JSON.parse(safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf8')) as Record<string, string>
  } catch {
    cache = {}
  }
  return cache
}

export function getSecret(name: string): string | undefined {
  return load()[name]
}

export function setSecret(name: string, value: string | null) {
  const all = load()
  if (value) all[name] = value
  else delete all[name]
  const json = JSON.stringify(all)
  ensureDir(userDir())
  fs.writeFileSync(path.join(userDir(), FILE), safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(json) : Buffer.from(json, 'utf8'))
}

export const secretHint = (value: string | undefined) => (value ? `…${value.slice(-4)}` : undefined)
