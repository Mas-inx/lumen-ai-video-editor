/**
 * Platform adapter. The UI never talks to Electron directly — everything goes
 * through this module so the same renderer also runs as a plain web app.
 */
import type { AppAPI } from '@shared/app'
import type { IntegrationsAPI } from '@shared/integrations'

interface LumenBridge {
  isElectron: true
  /** Launched by the automated test harness (exposes the debug handle). */
  testMode?: boolean
  platform: string
  versions: { electron: string; chrome: string }
  /** Blender, HyperFrames and MCP — desktop app only. */
  integrations?: IntegrationsAPI
  /** Files, projects and exports — desktop app only. */
  app?: AppAPI
}

declare global {
  interface Window {
    lumen?: LumenBridge
  }
}

const bridge = typeof window !== 'undefined' ? window.lumen : undefined

/** Files, projects and exports (undefined outside the desktop app). */
export const desktop: AppAPI | undefined = bridge?.app

/** The version baked in at build time from package.json. */
export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0'

function detectOs(): string {
  if (bridge) return bridge.platform
  const ua = navigator.userAgent
  if (/Mac|iPhone|iPad/.test(ua)) return 'darwin'
  if (/Win/.test(ua)) return 'win32'
  return 'linux'
}

const os = detectOs()

export const platform = {
  isElectron: Boolean(bridge?.isElectron),
  os,
  isMac: os === 'darwin',
  isWindows: os === 'win32',
  /** Label for the primary modifier key. */
  mod: os === 'darwin' ? '⌘' : 'Ctrl',
  alt: os === 'darwin' ? '⌥' : 'Alt',
  shift: os === 'darwin' ? '⇧' : 'Shift',
  versions: bridge?.versions,
} as const

/** Pretty-prints a shortcut like "mod+shift+z" for the current OS. */
export function formatShortcut(combo: string) {
  const map: Record<string, string> = {
    mod: platform.mod,
    alt: platform.alt,
    shift: platform.shift,
    space: 'Space',
    left: '←',
    right: '→',
    up: '↑',
    down: '↓',
    enter: '↵',
    esc: 'Esc',
    delete: 'Del',
    backspace: '⌫',
    home: 'Home',
    end: 'End',
  }
  return combo.split('+').map((k) => map[k] ?? k.toUpperCase())
}
