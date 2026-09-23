import { useEffect } from 'react'
import { useUI } from '@/editor/ui-store'
import { platform } from '@/lib/platform'
import { useSession } from '@/project/session'
import { SHORTCUTS } from './shortcuts'

const KEY_NAMES: Record<string, string> = {
  ' ': 'space',
  arrowleft: 'left',
  arrowright: 'right',
  arrowup: 'up',
  arrowdown: 'down',
  escape: 'esc',
}

function keyName(e: KeyboardEvent) {
  const k = e.key.toLowerCase()
  return KEY_NAMES[k] ?? k
}

/** Symbols typed with Shift on most layouts — don't require an explicit "shift+". */
const SHIFTED = new Set(['?', '+'])

export function matchesCombo(e: KeyboardEvent, combo: string) {
  const parts = combo.split('+')
  const key = combo === '+' || combo.endsWith('++') ? '+' : parts[parts.length - 1]
  const wantMod = parts.includes('mod')
  const wantShift = parts.includes('shift')
  const wantAlt = parts.includes('alt')
  const mod = platform.isMac ? e.metaKey : e.ctrlKey
  if (mod !== wantMod || e.altKey !== wantAlt) return false
  if (!SHIFTED.has(key) && e.shiftKey !== wantShift) return false
  return keyName(e) === key
}

function isTyping(target: EventTarget | null) {
  const el = target as HTMLElement | null
  if (!el) return false
  return el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT'
}

export function useGlobalShortcuts() {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return
      const typing = isTyping(e.target)
      const { paletteOpen, exportOpen, shortcutsOpen } = useUI.getState()
      const modal = paletteOpen || exportOpen || shortcutsOpen || document.querySelector('[role="menu"],[role="dialog"]')

      for (const s of SHORTCUTS) {
        if (!s.keys.some((combo) => matchesCombo(e, combo))) continue
        // The start screen only answers to opening a project.
        if (useSession.getState().home && s.id !== 'open') return
        if (typing && !s.global) return
        if (modal && !s.global) return
        e.preventDefault()
        s.run()
        return
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}
