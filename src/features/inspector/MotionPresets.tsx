import { Clapperboard, Diamond, LogIn, LogOut, Zap } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from '@/components/ui/menu'
import { Row, Section } from '@/components/ui/section'
import { Slider } from '@/components/ui/slider'
import { easeAt, EASING_GROUPS, easingLabel, type Easing } from '@/editor/easing'
import { MOTION_PRESETS, type PresetGroup } from '@/editor/motion-presets'
import { usePlayback } from '@/editor/playback'
import { dispatch } from '@/editor/store'
import type { Clip } from '@/editor/types'
import { cn } from '@/lib/cn'
import { clamp } from '@/lib/math'

/** A tiny drawing of a curve (time across, value up). */
export function CurveIcon({ easing, className }: { easing: Easing | string; className?: string }) {
  const n = 24
  // Overshooting curves leave the box a little: give them room.
  const pts: string[] = []
  for (let i = 0; i <= n; i++) {
    const t = i / n
    const y = easing === 'hold' ? (i === n ? 1 : 0) : easeAt(easing, t)
    pts.push(`${(2 + t * 20).toFixed(1)},${(18 - y * 14).toFixed(1)}`)
  }
  return (
    <svg viewBox="0 0 24 20" className={cn('size-5 shrink-0', className)} aria-hidden>
      <path d="M2 18H22M2 4H22" stroke="currentColor" strokeOpacity="0.15" strokeWidth="1" fill="none" />
      <polyline points={pts.join(' ')} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** Pick a curve: grouped by what each is for, each with its drawing. */
export function EasingMenu({ value, onChange, children, allowPreset }: { value: Easing | undefined; onChange: (e: Easing | undefined) => void; children: ReactNode; allowPreset?: boolean }) {
  return (
    <Menu>
      <MenuTrigger asChild>{children}</MenuTrigger>
      <MenuContent align="end" className="max-h-[60vh] w-64 overflow-y-auto">
        {allowPreset && (
          <>
            <MenuItem icon={<Clapperboard />} onSelect={() => onChange(undefined)}>
              Each preset’s own curves
            </MenuItem>
            <MenuSeparator />
          </>
        )}
        {EASING_GROUPS.map((g, gi) => (
          <div key={g.label}>
            {gi > 0 && <MenuSeparator />}
            <MenuLabel>
              {g.label} <span className="font-normal tracking-normal normal-case text-fg-4">· {g.hint}</span>
            </MenuLabel>
            {g.items.map((item) => (
              <MenuItem key={item.value} icon={<CurveIcon easing={item.value} className={cn(value === item.value && 'text-accent-2')} />} onSelect={() => onChange(item.value)}>
                <span className={cn(value === item.value && 'font-medium text-fg')}>{item.label}</span>
              </MenuItem>
            ))}
          </div>
        ))}
      </MenuContent>
    </Menu>
  )
}

const GROUPS: { id: PresetGroup; label: string; icon: ReactNode; hint: string }[] = [
  { id: 'camera', label: 'Camera', icon: <Clapperboard />, hint: 'Over the whole clip' },
  { id: 'in', label: 'In', icon: <LogIn />, hint: 'At the start' },
  { id: 'out', label: 'Out', icon: <LogOut />, hint: 'At the end' },
  { id: 'emphasis', label: 'Emphasis', icon: <Zap />, hint: 'At the playhead' },
]

/** One-click motion, baked into keyframes you can then fine-tune. */
export function MotionPresetsSection({ clip }: { clip: Clip }) {
  const [intensity, setIntensity] = useState(1)
  const [easing, setEasing] = useState<Easing | undefined>(undefined)
  const apply = (preset: string, group: PresetGroup) => {
    const local = clamp(usePlayback.getState().frame - clip.start, 0, clip.duration - 1)
    const res = dispatch('clip.animate', { clipId: clip.id, preset, intensity, easing, ...(group === 'emphasis' ? { at: local } : {}) })
    if (!res.ok) toast.error(res.error)
  }
  return (
    <Section title="Motion presets" icon={<Diamond />}>
      <div className="space-y-3.5">
        {GROUPS.map((g) => (
          <div key={g.id}>
            <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-fg-2 [&_svg]:size-3.5 [&_svg]:text-fg-4">
              {g.icon}
              {g.label}
              <span className="font-normal text-fg-4">· {g.hint}</span>
            </div>
            <div className="grid grid-cols-3 gap-1">
              {MOTION_PRESETS.filter((p) => p.group === g.id).map((p) => (
                <button
                  key={p.id}
                  type="button"
                  title={p.description}
                  onClick={() => apply(p.id, g.id)}
                  className="h-7 truncate rounded-md bg-white/[0.04] px-1.5 text-xs font-medium text-fg-3 transition-colors hover:bg-white/[0.08] hover:text-fg"
                >
                  {p.name}
                </button>
              ))}
            </div>
          </div>
        ))}
        <Row label="Intensity">
          <Slider value={intensity} min={0.25} max={2.5} step={0.05} onChange={setIntensity} />
          <span className="w-10 shrink-0 text-right text-xs text-fg-3 tabular">{Math.round(intensity * 100)}%</span>
        </Row>
        <Row label="Curve">
          <EasingMenu value={easing} onChange={setEasing} allowPreset>
            <button type="button" className="flex h-7 flex-1 items-center gap-2 rounded-md bg-white/[0.04] px-2 text-xs text-fg-2 hover:bg-white/[0.07]">
              {easing ? <CurveIcon easing={easing} /> : <Clapperboard className="size-3.5 text-fg-4" />}
              <span className="truncate">{easing ? easingLabel(easing) : 'Each preset’s own'}</span>
            </button>
          </EasingMenu>
        </Row>
        <p className="text-2xs leading-relaxed text-fg-4">Presets become keyframes — tweak them below. Land emphasis on a beat: put the playhead on the hit first.</p>
      </div>
    </Section>
  )
}
