import { Circle, Crosshair, Eye, EyeOff, Move, Plus, Square, Trash, Unlink } from 'lucide-react'
import { IconButton } from '@/components/ui/button'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/menu'
import { Row, Section } from '@/components/ui/section'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { dispatch } from '@/editor/store'
import type { Clip, Mask } from '@/editor/types'
import { useUI } from '@/editor/ui-store'
import { actions } from '@/features/shell/actions'
import { cn } from '@/lib/cn'

/** Shape masks: show part of a clip (or limit where an adjustment layer grades), with soft edges. */
export function MaskSection({ clip }: { clip: Clip }) {
  const masks = clip.masks ?? []
  const editing = useUI((s) => s.maskEdit)
  const add = (shape: Mask['shape']) => {
    const res = dispatch('mask.add', { clipId: clip.id, mask: { shape, ...(shape === 'rectangle' ? { width: 0.6, height: 0.6 } : {}) } })
    if (res.ok) useUI.getState().setMaskEdit(res.result as string)
  }
  const set = (m: Mask, patch: Partial<Omit<Mask, 'id' | 'follow'>> & { follow?: Mask['follow'] | null }, key?: string) => dispatch('mask.update', { clipId: clip.id, maskId: m.id, patch }, key ? { coalesce: `mask:${m.id}:${key}` } : undefined)

  return (
    <Section
      title="Masks"
      icon={<Circle />}
      defaultOpen={masks.length > 0}
      actions={
        <Menu>
          <MenuTrigger asChild>
            <IconButton size="xs" label="Add a mask">
              <Plus />
            </IconButton>
          </MenuTrigger>
          <MenuContent align="end" className="w-48">
            <MenuItem icon={<Circle />} onSelect={() => add('ellipse')}>
              Ellipse
            </MenuItem>
            <MenuItem icon={<Square />} onSelect={() => add('rectangle')}>
              Rectangle
            </MenuItem>
          </MenuContent>
        </Menu>
      }
    >
      {!masks.length ? (
        <p className="text-2xs leading-relaxed text-fg-4">
          {clip.kind === 'adjustment' ? 'Limit the grade to part of the frame — a face, the sky, a vignette of your own.' : 'Show only part of the clip — spotlight a subject, split the screen, soften an edge.'}
        </p>
      ) : (
        <div className="space-y-2">
          {masks.map((m, i) => {
            const on = editing === m.id
            return (
              <div key={m.id} className={cn('rounded-lg bg-white/[0.035] p-2 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.04)]', on && 'shadow-[inset_0_0_0_1.5px_rgb(214_238_0/0.5)]')}>
                <div className="flex items-center gap-1.5">
                  {m.shape === 'ellipse' ? <Circle className="size-3.5 text-fg-3" /> : <Square className="size-3.5 text-fg-3" />}
                  <span className="min-w-0 flex-1 truncate text-xs font-medium text-fg">
                    {m.shape === 'ellipse' ? 'Ellipse' : 'Rectangle'} {i + 1}
                  </span>
                  <IconButton size="xs" label={on ? 'Done editing on the canvas' : 'Edit on the canvas'} active={on} onClick={() => useUI.getState().setMaskEdit(on ? null : m.id)}>
                    <Move />
                  </IconButton>
                  <IconButton size="xs" label={m.follow ? 'Follows a tracked point — track again' : 'Track motion: make this mask follow something'} active={Boolean(m.follow)} onClick={() => actions.trackMotion(clip.id, m.id)}>
                    <Crosshair />
                  </IconButton>
                  {m.follow && (
                    <IconButton size="xs" label="Stop following" onClick={() => set(m, { follow: null })}>
                      <Unlink />
                    </IconButton>
                  )}
                  <IconButton size="xs" label={m.invert ? 'Showing outside — show inside' : 'Showing inside — show outside'} active={m.invert} onClick={() => set(m, { invert: !m.invert })}>
                    {m.invert ? <EyeOff /> : <Eye />}
                  </IconButton>
                  <IconButton size="xs" label="Remove mask" onClick={() => dispatch('mask.remove', { clipId: clip.id, maskId: m.id })}>
                    <Trash />
                  </IconButton>
                </div>
                <div className="mt-1.5 space-y-0.5">
                  <Row label="Feather">
                    <Slider value={m.feather * 200} min={0} max={100} defaultValue={8} onChange={(v) => set(m, { feather: Math.round(v) / 200 }, 'f')} />
                    <span className="w-8 text-right text-xs text-fg-3 tabular">{Math.round(m.feather * 200)}</span>
                  </Row>
                  <Row label="Opacity">
                    <Slider value={m.opacity * 100} min={0} max={100} defaultValue={100} onChange={(v) => set(m, { opacity: Math.round(v) / 100 }, 'o')} />
                    <span className="w-8 text-right text-xs text-fg-3 tabular">{Math.round(m.opacity * 100)}</span>
                  </Row>
                  {m.shape === 'rectangle' && (
                    <Row label="Roundness">
                      <Slider value={m.roundness * 100} min={0} max={100} defaultValue={0} onChange={(v) => set(m, { roundness: Math.round(v) / 100 }, 'r')} />
                      <span className="w-8 text-right text-xs text-fg-3 tabular">{Math.round(m.roundness * 100)}</span>
                    </Row>
                  )}
                  <Row label="Invert">
                    <span className="flex-1 text-2xs text-fg-4">{m.invert ? 'Hides the inside' : 'Shows the inside'}</span>
                    <Switch aria-label="Invert mask" checked={m.invert} onChange={(v) => set(m, { invert: v })} />
                  </Row>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </Section>
  )
}
