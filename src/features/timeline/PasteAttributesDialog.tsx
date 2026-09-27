import { Check } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { attributeSource, useClipboard } from '@/editor/clipboard'
import { ATTRIBUTES, type Attribute, type ClipSnapshot } from '@/editor/commands'
import { dispatch, getProject } from '@/editor/store'
import { isRamped } from '@/editor/timing'
import type { Clip } from '@/editor/types'
import { useUI } from '@/editor/ui-store'
import { cn } from '@/lib/cn'

const LABEL: Record<Attribute, { name: string; detail: string }> = {
  transform: { name: 'Transform', detail: 'Position, scale, rotation, opacity, 3D — with keyframes' },
  crop: { name: 'Crop', detail: 'Edges and rounded corners' },
  color: { name: 'Color', detail: 'Grade and look' },
  effects: { name: 'Effects', detail: 'Every effect and its amount' },
  audio: { name: 'Audio', detail: 'Volume (with keyframes), fades, voice clean-up' },
  speed: { name: 'Speed', detail: 'Speed, ramp and reverse' },
  animation: { name: 'Animation', detail: 'In and out animations' },
  text: { name: 'Text style', detail: 'Font, size, color, shadow — not the words' },
  blend: { name: 'Blend mode', detail: 'How the clip mixes with what’s below' },
}

/** The attributes a clip actually has worth copying, so the list only offers real choices. */
function available(c: Clip): Attribute[] {
  const visual = c.kind !== 'audio'
  const media = c.kind === 'video' || c.kind === 'audio'
  return ATTRIBUTES.filter((a) => {
    switch (a) {
      case 'transform':
      case 'animation':
      case 'effects':
        return visual
      case 'blend':
        return visual && c.blend !== 'normal'
      case 'crop':
        return Boolean(c.crop)
      case 'color':
        return visual && c.kind !== 'text'
      case 'audio':
        return media && !c.audio.detached
      case 'speed':
        return media && !c.freeze && (c.speed !== 1 || c.reverse || isRamped(c))
      case 'text':
        return c.kind === 'text'
    }
  })
}

/** Paste attributes: pick what to copy from the clip on the clipboard onto the selected clips. */
export function PasteAttributesDialog() {
  const open = useUI((s) => s.pasteAttributesOpen)
  const data = useClipboard((s) => s.data)
  const source = attributeSource()
  const choices = source ? available(source) : []
  const [picked, setPicked] = useState<Attribute[]>([])
  useEffect(() => {
    if (open) setPicked(choices)
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const close = () => useUI.getState().setPasteAttributesOpen(false)
  const apply = () => {
    const ids = useUI.getState().selection.filter((id) => getProject().clips[id])
    if (!source || !ids.length || !picked.length) return close()
    // The source clip may live in another project, so it travels whole.
    dispatch('clip.copyAttributes', { from: source as unknown as ClipSnapshot, ids, include: picked })
    close()
  }
  const toggle = (a: Attribute) => setPicked((p) => (p.includes(a) ? p.filter((x) => x !== a) : [...p, a]))
  const targets = useUI((s) => s.selection.length)

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && close()}
      title="Paste attributes"
      description={source ? `From “${source.name}” onto ${targets === 1 ? 'the selected clip' : `${targets} selected clips`}.` : 'Copy a clip first.'}
      className="w-[min(440px,calc(100vw-32px))]"
    >
      <div className="space-y-1 px-5 pb-4">
        {!data && <p className="py-6 text-center text-sm text-fg-3">Copy a clip (Ctrl+C) to paste its attributes.</p>}
        {source && !choices.length && <p className="py-6 text-center text-sm text-fg-3">“{source.name}” has nothing beyond the defaults to paste.</p>}
        {choices.map((a) => {
          const on = picked.includes(a)
          return (
            <button
              key={a}
              type="button"
              onClick={() => toggle(a)}
              className={cn('flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors', on ? 'bg-accent/10' : 'hover:bg-white/[0.04]')}
            >
              <span className={cn('grid size-4 shrink-0 place-items-center rounded-[5px] ring-1 ring-inset', on ? 'bg-accent text-accent-fg ring-accent' : 'ring-line-2')}>
                {on && <Check className="size-3" strokeWidth={3} />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-fg">{LABEL[a].name}</span>
                <span className="block truncate text-2xs text-fg-4">{LABEL[a].detail}</span>
              </span>
            </button>
          )
        })}
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-line bg-black/15 px-5 py-3.5">
        <Button variant="ghost" onClick={close}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!picked.length || !source} onClick={apply}>
          Paste {picked.length > 0 && picked.length < choices.length ? `${picked.length} of ${choices.length}` : 'all'}
        </Button>
      </div>
    </Dialog>
  )
}
