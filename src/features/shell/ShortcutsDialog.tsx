import { Dialog } from '@/components/ui/dialog'
import { Kbd } from '@/components/ui/kbd'
import { useUI } from '@/editor/ui-store'
import { SHORTCUTS, type Shortcut } from './shortcuts'

const GROUPS: Shortcut['group'][] = ['Playback', 'Editing', 'Multicam', 'Tools', 'View', 'App']

export function ShortcutsDialog() {
  const open = useUI((s) => s.shortcutsOpen)
  const setOpen = useUI((s) => s.setShortcutsOpen)
  return (
    <Dialog open={open} onOpenChange={setOpen} title="Keyboard shortcuts" description="Work at the speed of thought — every action has a key." className="w-[min(820px,calc(100vw-32px))]">
      <div className="grid max-h-[70vh] grid-cols-2 gap-x-8 gap-y-6 overflow-y-auto px-5 pt-2 pb-6">
        {GROUPS.map((group) => (
          <div key={group}>
            <h3 className="mb-2 text-2xs font-semibold tracking-wider text-fg-4 uppercase">{group}</h3>
            <div className="space-y-0.5">
              {SHORTCUTS.filter((s) => s.group === group).map((s) => (
                <div key={s.id} className="flex h-7 items-center justify-between gap-4 rounded-md px-2 text-sm text-fg-2 hover:bg-white/[0.03]">
                  <span className="truncate">{s.label}</span>
                  <Kbd combo={s.keys[0]} />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Dialog>
  )
}
