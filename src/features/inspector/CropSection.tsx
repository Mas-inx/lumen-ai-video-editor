import { Crop as CropIcon, RotateCcw, Scan } from 'lucide-react'
import { Button, IconButton } from '@/components/ui/button'
import { Section } from '@/components/ui/section'
import { dispatch, useEditor } from '@/editor/store'
import type { Clip, Crop } from '@/editor/types'
import { useUI } from '@/editor/ui-store'
import { cn } from '@/lib/cn'
import { ValueSlider } from './controls'

const NO_CROP: Crop = { left: 0, right: 0, top: 0, bottom: 0, radius: 0 }

/** Aspect presets: the crop that keeps the most picture at that shape, centered. */
const SHAPES = [
  { id: 'free', label: 'Free', ratio: 0 },
  { id: '16:9', label: '16:9', ratio: 16 / 9 },
  { id: '1:1', label: '1:1', ratio: 1 },
  { id: '9:16', label: '9:16', ratio: 9 / 16 },
  { id: '4:5', label: '4:5', ratio: 4 / 5 },
  { id: 'circle', label: 'Circle', ratio: 1 },
] as const

function cropFor(ratio: number, srcW: number, srcH: number): Pick<Crop, 'left' | 'right' | 'top' | 'bottom'> {
  const src = srcW / srcH
  if (Math.abs(src - ratio) < 0.001) return { left: 0, right: 0, top: 0, bottom: 0 }
  if (src > ratio) {
    const side = (1 - ratio / src) / 2
    return { left: side, right: side, top: 0, bottom: 0 }
  }
  const side = (1 - src / ratio) / 2
  return { left: 0, right: 0, top: side, bottom: side }
}

export function CropSection({ clip }: { clip: Clip }) {
  const asset = useEditor((s) => (clip.assetId ? s.project.assets[clip.assetId] : undefined))
  const cropMode = useUI((s) => s.cropMode)
  const crop = clip.crop ?? NO_CROP
  const set = (patch: Partial<Crop>, key?: string) => dispatch('clip.update', { ids: [clip.id], patch: { crop: patch } }, { coalesce: key, label: 'Crop' })
  const pct = (v: number) => Math.round(v * 1000) / 10
  const edge = (side: 'left' | 'right' | 'top' | 'bottom', label: string, opposite: 'left' | 'right' | 'top' | 'bottom') => (
    <ValueSlider
      label={label}
      value={pct(crop[side])}
      min={0}
      max={95}
      step={0.5}
      unit="%"
      onChange={(v) => set({ [side]: Math.min(v / 100, 0.95 - crop[opposite]) }, `crop:${clip.id}:${side}`)}
    />
  )
  const srcW = asset?.width ?? 16
  const srcH = asset?.height ?? 9
  const shape = SHAPES.find((s) => {
    if (s.id === 'free') return false
    const c = cropFor(s.ratio, srcW, srcH)
    const round = s.id === 'circle' ? crop.radius >= 0.999 : crop.radius < 0.999
    return round && (['left', 'right', 'top', 'bottom'] as const).every((k) => Math.abs(c[k] - crop[k]) < 0.002) && Boolean(clip.crop)
  })

  return (
    <Section
      title="Crop"
      icon={<CropIcon />}
      defaultOpen={Boolean(clip.crop)}
      actions={
        clip.crop && (
          <IconButton size="xs" label="Reset crop" onClick={() => dispatch('clip.update', { ids: [clip.id], patch: { crop: null } }, { label: 'Reset crop' })}>
            <RotateCcw />
          </IconButton>
        )
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-6 gap-1">
          {SHAPES.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() =>
                s.id === 'free'
                  ? useUI.getState().setCropMode(true)
                  : set({ ...cropFor(s.ratio, srcW, srcH), radius: s.id === 'circle' ? 1 : Math.min(crop.radius, 0.99) })
              }
              className={cn(
                'h-7 rounded-md text-2xs font-medium tabular transition-colors',
                (shape?.id ?? (clip.crop ? 'free' : '')) === s.id
                  ? 'bg-accent/18 text-accent-2 shadow-[inset_0_0_0_1px_rgb(214_238_0/0.4)]'
                  : 'bg-white/[0.04] text-fg-3 hover:bg-white/[0.07] hover:text-fg',
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
        <div className="space-y-1">
          {edge('left', 'Left', 'right')}
          {edge('right', 'Right', 'left')}
          {edge('top', 'Top', 'bottom')}
          {edge('bottom', 'Bottom', 'top')}
          <ValueSlider label="Corners" value={Math.round(crop.radius * 100)} min={0} max={100} unit="%" onChange={(v) => set({ radius: v / 100 }, `crop:${clip.id}:radius`)} />
        </div>
        <Button size="sm" variant={cropMode ? 'primary' : 'secondary'} className="w-full" onClick={() => useUI.getState().setCropMode(!cropMode)}>
          <Scan className="size-3.5" />
          {cropMode ? 'Done cropping' : 'Crop on the canvas'}
        </Button>
      </div>
    </Section>
  )
}
