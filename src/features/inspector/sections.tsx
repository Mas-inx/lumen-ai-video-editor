import {
  Aperture,
  AudioLines,
  Box,
  Rotate3d,
  Blend,
  Bold,
  CaseUpper,
  Diamond,
  Gauge,
  Italic,
  Link2,
  Move,
  Palette,
  Plus,
  RotateCcw,
  Snowflake,
  Sparkles,
  TextAlignCenter,
  TextAlignEnd,
  TextAlignStart,
  Type,
  WandSparkles,
  X,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { AiSparkle } from '@/components/brand'
import { Button, IconButton } from '@/components/ui/button'
import { ScrubInput } from '@/components/ui/scrub-input'
import { Row, Section } from '@/components/ui/section'
import { Segmented } from '@/components/ui/segmented'
import { Select } from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/menu'
import type { ClipPatch } from '@/editor/commands'
import { DEFAULT_COLOR } from '@/editor/defaults'
import { setAnimatable } from '@/editor/edit'
import { ANIMATABLE } from '@/editor/keyframes'
import { ANIMATIONS, EFFECTS, LOOKS } from '@/editor/presets'
import { isRamped } from '@/editor/timing'
import { dispatch, useEditor } from '@/editor/store'
import type { AnimPreset, BlendMode, Clip, ColorGrade, Material3D, TextStyle } from '@/editor/types'
import { useUI } from '@/editor/ui-store'
import { usePreviewArt } from '@/engine/preview-art'
import { EffectPreview } from '@/features/assets/EffectsPanel'
import { assetThumb } from '@/features/assets/shared'
import { cn } from '@/lib/cn'
import { formatDuration } from '@/lib/time'
import { ColorSwatches, KeyframeButton, PropSlider, usePropValue, ValueSlider } from './controls'
import { SpeedRamp } from './SpeedRamp'
import { KeyParams } from './KeyParams'
import { CurvesSection, HslSection, LutSection, WheelsSection } from './GradeSections'
import { FontPicker } from './FontPicker'
import { fontCss } from '@/engine/fonts'

const update = (ids: string[], patch: ClipPatch, key?: string) =>
  dispatch('clip.update', { ids, patch }, { coalesce: key })

// ─── Transform ───────────────────────────────────────────────────────────

export function TransformSection({ clip }: { clip: Clip }) {
  const reset = () => {
    for (const p of ['x', 'y', 'scale', 'rotation', 'opacity', 'rotateX', 'rotateY', 'z'] as const) if (clip.keyframes[p]) dispatch('keyframe.clear', { clipId: clip.id, prop: p })
    update([clip.id], { transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, rotateX: 0, rotateY: 0, z: 0 } })
  }
  return (
    <Section
      title="Transform"
      icon={<Move />}
      actions={
        <IconButton size="xs" label="Reset transform" onClick={reset}>
          <RotateCcw />
        </IconButton>
      }
    >
      <div className="space-y-1">
        <PositionRow clip={clip} />
        <PropSlider clip={clip} prop="scale" label="Scale" min={0.05} max={4} step={1} display={(v) => Math.round(v * 100)} fromDisplay={(v) => v / 100} unit="%" defaultValue={1} />
        <PropSlider clip={clip} prop="rotation" label="Rotation" min={-180} max={180} step={1} unit="°" defaultValue={0} bipolar />
        <PropSlider clip={clip} prop="opacity" label="Opacity" min={0} max={1} step={1} display={(v) => Math.round(v * 100)} fromDisplay={(v) => v / 100} unit="%" defaultValue={1} />
      </div>
    </Section>
  )
}

/** Real 3D placement — any clip can tilt, turn and move in depth, all keyframable. */
export function Space3DSection({ clip }: { clip: Clip }) {
  const active = Boolean((clip.transform.rotateX ?? 0) || (clip.transform.rotateY ?? 0) || (clip.transform.z ?? 0) || clip.keyframes.rotateX || clip.keyframes.rotateY || clip.keyframes.z)
  const reset = () => {
    for (const p of ['rotateX', 'rotateY', 'z'] as const) if (clip.keyframes[p]) dispatch('keyframe.clear', { clipId: clip.id, prop: p })
    update([clip.id], { transform: { rotateX: 0, rotateY: 0, z: 0 } })
  }
  return (
    <Section
      title="3D space"
      icon={<Rotate3d />}
      actions={
        active ? (
          <IconButton size="xs" label="Flatten" onClick={reset}>
            <RotateCcw />
          </IconButton>
        ) : undefined
      }
    >
      <div className="space-y-1">
        <PropSlider clip={clip} prop="rotateX" label="Tilt X" min={-180} max={180} unit="°" defaultValue={0} bipolar />
        <PropSlider clip={clip} prop="rotateY" label="Turn Y" min={-180} max={180} unit="°" defaultValue={0} bipolar />
        <PropSlider clip={clip} prop="z" label="Depth" min={-3000} max={900} step={5} unit="px" defaultValue={0} bipolar />
      </div>
      {!active && <p className="mt-2 text-2xs leading-relaxed text-fg-4">Tilt or turn to place this clip in real 3D perspective. Keyframe it for camera-style moves.</p>}
    </Section>
  )
}

function PositionRow({ clip }: { clip: Clip }) {
  const x = usePropValue(clip, 'x')
  const y = usePropValue(clip, 'y')
  return (
    <>
      <Row label="Position" trailing={<KeyframeButton clip={clip} prop="x" />}>
        <ScrubInput prefix="X" value={x} onChange={(v) => setAnimatable(clip.id, 'x', Math.round(v), `insp:${clip.id}:x`)} step={1} className="flex-1" />
        <ScrubInput prefix="Y" value={y} onChange={(v) => setAnimatable(clip.id, 'y', Math.round(v), `insp:${clip.id}:y`)} step={1} className="flex-1" />
      </Row>
      {clip.keyframes.y?.length ? (
        <Row label="" trailing={<KeyframeButton clip={clip} prop="y" />} className="-mt-1 min-h-6">
          <span className="text-2xs text-fg-4">Y is animated separately</span>
        </Row>
      ) : null}
    </>
  )
}

const BLENDS: { value: BlendMode; label: string }[] = [
  { value: 'normal', label: 'Normal' },
  { value: 'screen', label: 'Screen' },
  { value: 'multiply', label: 'Multiply' },
  { value: 'overlay', label: 'Overlay' },
  { value: 'soft-light', label: 'Soft light' },
  { value: 'lighten', label: 'Lighten' },
  { value: 'darken', label: 'Darken' },
  { value: 'color-dodge', label: 'Color dodge' },
  { value: 'difference', label: 'Difference' },
]

export function CompositingSection({ clip }: { clip: Clip }) {
  return (
    <Section title="Compositing" icon={<Blend />} defaultOpen={false}>
      <Row label="Blend mode">
        <Select aria-label="Blend mode" value={clip.blend} onChange={(v) => update([clip.id], { blend: v })} options={BLENDS} className="w-full" />
      </Row>
    </Section>
  )
}

// ─── Effects ─────────────────────────────────────────────────────────────

export function EffectsSection({ clip }: { clip: Clip }) {
  const available = EFFECTS.filter((e) => !clip.effects.some((c) => c.kind === e.kind))
  const art = usePreviewArt()
  const asset = useEditor((s) => (clip.assetId ? s.project.assets[clip.assetId] : undefined))
  const preview = { a: (asset && asset.kind !== 'audio' ? assetThumb(asset) : undefined) ?? art.a }
  return (
    <Section
      title="Effects"
      icon={<Sparkles />}
      actions={
        <Menu>
          <MenuTrigger asChild>
            <IconButton size="xs" label="Add effect" disabled={!available.length}>
              <Plus />
            </IconButton>
          </MenuTrigger>
          <MenuContent align="end" className="w-56">
            {available.map((e) => (
              <MenuItem key={e.kind} onSelect={() => dispatch('effect.add', { ids: [clip.id], kind: e.kind })}>
                {e.name}
              </MenuItem>
            ))}
          </MenuContent>
        </Menu>
      }
    >
      {!clip.effects.length ? (
        <button
          type="button"
          onClick={() => useUI.getState().setLeftTab('effects')}
          className="flex w-full items-center gap-2.5 rounded-lg border border-dashed border-line-2 px-3 py-2.5 text-left text-xs text-fg-3 transition-colors hover:border-line-3 hover:text-fg-2"
        >
          <Sparkles className="size-3.5" />
          Drag effects onto clips, or browse the Effects library
        </button>
      ) : (
        <div className="space-y-2">
          {clip.effects.map((fx) => {
            const meta = EFFECTS.find((e) => e.kind === fx.kind)!
            return (
              <div key={fx.id} className={cn('rounded-lg bg-white/[0.035] p-2 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.04)]', !fx.enabled && 'opacity-55')}>
                <div className="flex items-center gap-2">
                  <EffectPreview kind={fx.kind} src={preview.a} className="h-7 w-12 shrink-0 rounded-md" />
                  <span className="min-w-0 flex-1 truncate text-xs font-medium text-fg">{meta.name}</span>
                  <Switch aria-label={`Toggle ${meta.name}`} checked={fx.enabled} onChange={(v) => dispatch('effect.update', { clipId: clip.id, effectId: fx.id, patch: { enabled: v } })} />
                  <IconButton size="xs" label="Remove effect" onClick={() => dispatch('effect.remove', { clipId: clip.id, effectId: fx.id })}>
                    <X />
                  </IconButton>
                </div>
                <div className="mt-1.5 flex items-center gap-2 pl-1">
                  <Slider value={fx.amount} min={0} max={100} onChange={(v) => dispatch('effect.update', { clipId: clip.id, effectId: fx.id, patch: { amount: v } }, { coalesce: `fx:${fx.id}` })} />
                  <span className="w-8 text-right text-xs text-fg-3 tabular">{Math.round(fx.amount)}</span>
                </div>
                {(fx.kind === 'chromaKey' || fx.kind === 'lumaKey') && fx.enabled && <KeyParams clip={clip} fx={fx} />}
              </div>
            )
          })}
        </div>
      )}
    </Section>
  )
}

// ─── Color ───────────────────────────────────────────────────────────────

const GRADIENTS = {
  temperature: 'linear-gradient(90deg, #4f8cff, #c9d4e4 50%, #ffac4d)',
  tint: 'linear-gradient(90deg, #44d17a, #cfd6cf 50%, #ff5fd2)',
  saturation: 'linear-gradient(90deg, #7a7a7a, #c2b8ff 50%, #ff6fae)',
}

export function ColorSections({ clips }: { clips: Clip[] }) {
  const clip = clips[0]
  const ids = clips.map((c) => c.id)
  const g = clip.color
  const set = (k: keyof ColorGrade) => (v: number) => update(ids, { color: { [k]: v }, look: null }, `color:${ids.join()}:${k}`)
  const look = LOOKS.find((l) => l.id === clip.look)

  return (
    <>
      <Section
        title="Look"
        icon={<Aperture />}
        actions={
          <IconButton size="xs" label="Reset color" onClick={() => update(ids, { color: { ...DEFAULT_COLOR, curves: null, wheels: null, hsl: null, lut: null }, look: null })}>
            <RotateCcw />
          </IconButton>
        }
      >
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-fg">{look?.name ?? 'Custom'}</div>
            <div className="text-2xs text-fg-4">{look ? 'Preset look — tweak it below' : 'Hand-graded'}</div>
          </div>
          <Button size="sm" variant="secondary" onClick={() => useUI.getState().setLeftTab('looks')}>
            <Palette />
            Browse looks
          </Button>
        </div>
      </Section>
      <Section title="Light" icon={<Aperture />}>
        <div className="space-y-1">
          <ValueSlider label="Exposure" value={g.exposure} onChange={set('exposure')} min={-100} max={100} bipolar />
          <ValueSlider label="Contrast" value={g.contrast} onChange={set('contrast')} min={-100} max={100} bipolar />
          <ValueSlider label="Vignette" value={g.vignette} onChange={set('vignette')} min={0} max={100} />
        </div>
      </Section>
      <Section title="Color" icon={<Palette />}>
        <div className="space-y-1">
          <ValueSlider label="Saturation" value={g.saturation} onChange={set('saturation')} min={-100} max={100} gradient={GRADIENTS.saturation} />
          <ValueSlider label="Temperature" value={g.temperature} onChange={set('temperature')} min={-100} max={100} gradient={GRADIENTS.temperature} />
          <ValueSlider label="Tint" value={g.tint} onChange={set('tint')} min={-100} max={100} gradient={GRADIENTS.tint} />
        </div>
      </Section>
      <WheelsSection clips={clips} />
      <CurvesSection clips={clips} />
      <HslSection clips={clips} />
      <LutSection clips={clips} />
    </>
  )
}

// ─── Audio ───────────────────────────────────────────────────────────────

export function AudioSection({ clip, fps }: { clip: Clip; fps: number }) {
  const a = clip.audio
  const maxFade = Math.floor(clip.duration / 2)
  if (clip.freeze) return <Note icon={<Snowflake />} text="A freeze frame holds one picture, so it plays no sound." />
  if (a.detached)
    return (
      <Note
        icon={<Link2 />}
        text="This clip’s sound is on its own audio clip, linked to it — select that clip to mix it, or trim it separately for J- and L-cuts."
        action={
          <Button size="sm" variant="secondary" onClick={() => dispatch('clip.reattachAudio', { ids: [clip.id] })}>
            Reattach audio
          </Button>
        }
      />
    )
  return (
    <>
      <Section title="Volume" icon={<AudioLines />}>
        <div className="space-y-1">
          <PropSlider clip={clip} prop="volume" label="Level" min={-60} max={12} step={0.5} precision={1} unit="dB" defaultValue={0} />
          <ValueSlider label="Fade in" value={a.fadeIn} onChange={(v) => update([clip.id], { audio: { fadeIn: Math.round(v) } }, `fin:${clip.id}`)} min={0} max={maxFade} unit="f" />
          <ValueSlider label="Fade out" value={a.fadeOut} onChange={(v) => update([clip.id], { audio: { fadeOut: Math.round(v) } }, `fout:${clip.id}`)} min={0} max={maxFade} unit="f" />
          <p className="pl-[84px] text-2xs text-fg-4">
            {formatDuration(a.fadeIn, fps)} in · {formatDuration(a.fadeOut, fps)} out
          </p>
        </div>
      </Section>
      <Section title="Enhance" icon={<WandSparkles />}>
        <div className="space-y-2.5">
          <AiToggle label="Studio voice" description="Cut rumble and mud, add presence, even out levels" checked={a.enhance} onChange={(v) => update([clip.id], { audio: { enhance: v } })} />
          <AiToggle label="Reduce noise" description="Neural noise suppression for fans, traffic, hiss and wind" checked={a.denoise} onChange={(v) => update([clip.id], { audio: { denoise: v } })} />
        </div>
      </Section>
    </>
  )
}

function Note({ icon, text, action }: { icon: ReactNode; text: string; action?: ReactNode }) {
  return (
    <div className="m-4 flex gap-3 rounded-xl bg-white/[0.035] p-3.5 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.05)]">
      <span className="mt-0.5 text-fg-3 [&_svg]:size-4">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="text-xs leading-relaxed text-fg-3">{text}</p>
        {action && <div className="mt-2.5">{action}</div>}
      </div>
    </div>
  )
}

function AiToggle({ label, description, checked, onChange }: { label: string; description: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center gap-3">
      <AiSparkle className="size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="text-sm text-fg">{label}</div>
        <div className="text-2xs text-fg-4">{description}</div>
      </div>
      <Switch aria-label={label} checked={checked} onChange={onChange} />
    </div>
  )
}

// ─── Speed ───────────────────────────────────────────────────────────────

const SPEED_PRESETS = [0.25, 0.5, 1, 1.5, 2, 4]

export function SpeedSection({ clips, fps }: { clips: Clip[]; fps: number }) {
  const clip = clips[0]
  const ids = clips.map((c) => c.id)
  const ramped = clips.some(isRamped)
  if (clips.length === 1 && clip.freeze)
    return <Note icon={<Snowflake />} text={`Freeze frame — holds one picture for ${formatDuration(clip.duration, fps)}. Trim it to hold longer or shorter.`} />
  return (
    <>
    <Section title="Speed" icon={<Gauge />}>
      <div className="space-y-3">
        <div className="grid grid-cols-6 gap-1">
          {SPEED_PRESETS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => update(ids, { speed: s })}
              className={cn(
                'h-7 rounded-md text-xs font-medium tabular transition-colors',
                clip.speed === s && !ramped ? 'bg-accent/18 text-accent-2 shadow-[inset_0_0_0_1px_rgb(214_238_0/0.4)]' : 'bg-white/[0.04] text-fg-3 hover:bg-white/[0.07] hover:text-fg',
              )}
            >
              {s}×
            </button>
          ))}
        </div>
        <Row label="Custom">
          <Slider value={Math.log2(clip.speed)} min={-2} max={3} step={0.01} defaultValue={0} onChange={(v) => update(ids, { speed: Math.round(Math.pow(2, v) * 100) / 100 }, `speed:${ids.join()}`)} />
          <ScrubInput value={clip.speed} onChange={(v) => update(ids, { speed: v }, `speed:${ids.join()}`)} min={0.1} max={16} step={0.05} precision={2} unit="×" className="w-[64px] shrink-0" />
        </Row>
        <Row label="Reverse">
          <Switch aria-label="Reverse" checked={clip.reverse} onChange={(v) => update(ids, { reverse: v })} />
        </Row>
        {clips.length === 1 && (
          <p className="text-2xs text-fg-4">
            Clip length {formatDuration(clip.duration, fps)} · {ramped ? 'a constant speed replaces the ramp' : 'changing speed keeps the same footage and adjusts the length'}.
          </p>
        )}
      </div>
    </Section>
    {clips.length === 1 && (
      <Section title="Speed ramp" icon={<Gauge />} defaultOpen={ramped}>
        <SpeedRamp clip={clip} />
      </Section>
    )}
    </>
  )
}

// ─── Animation ───────────────────────────────────────────────────────────

export function AnimateSection({ clip, fps }: { clip: Clip; fps: number }) {
  const presets = ANIMATIONS.filter((a) => !a.textOnly || clip.kind === 'text')
  const animated = ANIMATABLE.filter((p) => clip.keyframes[p]?.length)
  const Picker = ({ dir }: { dir: 'in' | 'out' }) => {
    const spec = clip.animation[dir]
    return (
      <div className="space-y-2">
        <div className="text-xs font-medium text-fg-2">{dir === 'in' ? 'In' : 'Out'}</div>
        <div className="grid grid-cols-3 gap-1">
          {presets.map((a) => (
            <button
              key={a.preset}
              type="button"
              onClick={() => update([clip.id], { animation: { [dir]: { preset: a.preset as AnimPreset } } })}
              className={cn(
                'h-7 rounded-md text-xs font-medium transition-colors',
                spec.preset === a.preset ? 'bg-accent/18 text-accent-2 shadow-[inset_0_0_0_1px_rgb(214_238_0/0.4)]' : 'bg-white/[0.04] text-fg-3 hover:bg-white/[0.07] hover:text-fg',
              )}
            >
              {a.name}
            </button>
          ))}
        </div>
        {spec.preset !== 'none' && (
          <Row label="Duration">
            <Slider value={spec.duration} min={2} max={Math.max(4, Math.min(clip.duration, fps * 3))} onChange={(v) => update([clip.id], { animation: { [dir]: { duration: Math.round(v) } } }, `anim:${clip.id}:${dir}`)} />
            <span className="w-12 shrink-0 text-right text-xs text-fg-3 tabular">{formatDuration(spec.duration, fps)}</span>
          </Row>
        )}
      </div>
    )
  }
  return (
    <>
      <Section title="Animation" icon={<Sparkles />}>
        <div className="space-y-4">
          <Picker dir="in" />
          <Picker dir="out" />
        </div>
      </Section>
      <Section title="Keyframes" icon={<Diamond />}>
        {animated.length ? (
          <div className="space-y-1">
            {animated.map((p) => (
              <div key={p} className="flex h-8 items-center gap-2 rounded-md px-1 text-sm">
                <Diamond className="size-3 fill-accent-2 text-accent-2" />
                <span className="flex-1 text-fg-2 capitalize">{p}</span>
                <span className="text-xs text-fg-4 tabular">{clip.keyframes[p]!.length} keys</span>
                <IconButton size="xs" label={`Clear ${p} animation`} onClick={() => dispatch('keyframe.clear', { clipId: clip.id, prop: p })}>
                  <X />
                </IconButton>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs leading-relaxed text-fg-4">
            Click the <Diamond className="inline size-3 align-[-2px]" /> next to any property to start animating it. Move the playhead and change the value — a keyframe is added automatically.
          </p>
        )}
      </Section>
    </>
  )
}

// ─── Text ────────────────────────────────────────────────────────────────

const MATERIALS: { id: Material3D; label: string; swatch: string }[] = [
  { id: 'chrome', label: 'Chrome', swatch: 'linear-gradient(135deg,#fdfdff,#8d93a3 55%,#e9ecf3)' },
  { id: 'gold', label: 'Gold', swatch: 'linear-gradient(135deg,#fff1c1,#c8912f 55%,#f7d27b)' },
  { id: 'matte', label: 'Matte', swatch: 'linear-gradient(135deg,#e5f75c,#a8bc00)' },
  { id: 'neon', label: 'Neon', swatch: 'radial-gradient(circle,#ffffff 20%,#d6ee00 60%,#5c6b00)' },
]

const WEIGHTS = [
  { value: '300', label: 'Light' },
  { value: '400', label: 'Regular' },
  { value: '500', label: 'Medium' },
  { value: '600', label: 'Semibold' },
  { value: '700', label: 'Bold' },
  { value: '800', label: 'Heavy' },
]

export function TextSection({ clip }: { clip: Clip }) {
  const t = clip.text!
  const projectFonts = { fonts: useEditor((s) => s.project.fonts) }
  const set = (patch: Partial<TextStyle>, key?: string) => update([clip.id], { text: patch, ...(patch.content !== undefined && { name: patch.content.split('\n')[0] || 'Title' }) }, key)
  return (
    <>
      <Section title="Text" icon={<Type />}>
        <div className="space-y-3">
          <textarea
            value={t.content}
            onChange={(e) => set({ content: e.target.value }, `text:${clip.id}`)}
            onKeyDown={(e) => e.stopPropagation()}
            rows={Math.min(5, t.content.split('\n').length + 1)}
            className="w-full resize-none rounded-lg bg-white/[0.045] px-2.5 py-2 text-sm leading-relaxed text-fg shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)] outline-none focus:shadow-[inset_0_0_0_1px_rgb(214_238_0/0.5),0_0_0_3px_rgb(214_238_0/0.12)]"
            style={{ fontFamily: fontCss(t.font, projectFonts) }}
          />
          <Row label="Font">
            <FontPicker value={t.font} onChange={(font) => set({ font })} />
          </Row>
          <Row label="Weight">
            <Select aria-label="Weight" value={String(t.weight)} onChange={(w) => set({ weight: Number(w) })} options={WEIGHTS} className="w-full" />
          </Row>
          <Row label="Size">
            <Slider value={t.size} min={12} max={300} defaultValue={96} onChange={(size) => set({ size: Math.round(size) }, `tsize:${clip.id}`)} />
            <ScrubInput value={t.size} onChange={(size) => set({ size: Math.round(size) }, `tsize:${clip.id}`)} min={4} max={800} unit="px" className="w-[64px] shrink-0" />
          </Row>
          <Row label="Style">
            <Segmented
              value={t.align}
              onChange={(align) => set({ align })}
              options={[
                { value: 'left', icon: <TextAlignStart />, title: 'Align left' },
                { value: 'center', icon: <TextAlignCenter />, title: 'Center' },
                { value: 'right', icon: <TextAlignEnd />, title: 'Align right' },
              ]}
            />
            <div className="flex gap-0.5">
              <IconButton size="xs" label="Uppercase" active={t.uppercase} onClick={() => set({ uppercase: !t.uppercase })}>
                <CaseUpper />
              </IconButton>
              <IconButton size="xs" label="Italic" active={t.italic} onClick={() => set({ italic: !t.italic })}>
                <Italic />
              </IconButton>
              <IconButton size="xs" label="Bold" active={t.weight >= 700} onClick={() => set({ weight: t.weight >= 700 ? 500 : 700 })}>
                <Bold />
              </IconButton>
            </div>
          </Row>
          <Row label="Tracking">
            <Slider value={t.letterSpacing * 100} min={-10} max={80} bipolar defaultValue={0} onChange={(v) => set({ letterSpacing: Math.round(v) / 100 }, `track:${clip.id}`)} />
            <span className="w-10 shrink-0 text-right text-xs text-fg-3 tabular">{Math.round(t.letterSpacing * 100)}</span>
          </Row>
          <Row label="Color">
            <ColorSwatches value={t.color} onChange={(c) => c && set({ color: c })} />
          </Row>
        </div>
      </Section>
      <Section title="3D extrusion" icon={<Box />} defaultOpen={t.extrude > 0}>
        <div className="space-y-3">
          <Row label="Depth">
            <Slider value={t.extrude * 100} min={0} max={80} defaultValue={0} onChange={(v) => set({ extrude: Math.round(v) / 100 }, `extrude:${clip.id}`)} />
            <span className="w-10 shrink-0 text-right text-xs text-fg-3 tabular">{t.extrude ? Math.round(t.extrude * 100) : 'Flat'}</span>
          </Row>
          <Row label="Material">
            <div className="grid flex-1 grid-cols-4 gap-1">
              {MATERIALS.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => set({ material: m.id, extrude: t.extrude || 0.3 })}
                  className={cn(
                    'flex flex-col items-center gap-1 rounded-md py-1.5 text-2xs font-medium transition-colors',
                    t.material === m.id && t.extrude > 0 ? 'bg-accent/15 text-accent-2 shadow-[inset_0_0_0_1px_rgb(214_238_0/0.45)]' : 'bg-white/[0.035] text-fg-3 hover:bg-white/[0.06] hover:text-fg-2',
                  )}
                >
                  <span className="size-4 rounded-full shadow-[inset_0_1px_0_rgb(255_255_255/0.5),0_1px_2px_rgb(0_0_0/0.5)]" style={{ background: m.swatch }} />
                  {m.label}
                </button>
              ))}
            </div>
          </Row>
          <Row label="Bevel">
            <Switch aria-label="Bevel" checked={t.bevel} onChange={(bevel) => set({ bevel })} />
          </Row>
          {t.extrude === 0 && <p className="text-2xs leading-relaxed text-fg-4">Give the title depth to render it as real 3D geometry — lit, reflective, and animatable in 3D.</p>}
        </div>
      </Section>
      <Section title="Outline, box & glow" icon={<Palette />} defaultOpen={Boolean(t.background || t.glow || t.outline)}>
        <div className="space-y-3">
          <Row label="Outline">
            <ColorSwatches allowNone value={t.outline?.color ?? null} onChange={(c) => set({ outline: c ? { color: c, width: t.outline?.width ?? 0.06 } : null })} />
          </Row>
          {t.outline && (
            <Row label="Thickness">
              <Slider value={t.outline.width * 100} min={1} max={30} defaultValue={6} onChange={(v) => set({ outline: { color: t.outline!.color, width: Math.round(v) / 100 } }, `outline:${clip.id}`)} />
              <span className="w-10 shrink-0 text-right text-xs text-fg-3 tabular">{Math.round(t.outline.width * 100)}</span>
            </Row>
          )}
          <Row label="Box">
            <ColorSwatches allowNone value={t.background} onChange={(c) => set({ background: c ? `${c}cc` : null })} />
          </Row>
          <Row label="Glow">
            <ColorSwatches allowNone value={t.glow} onChange={(c) => set({ glow: c })} />
          </Row>
          <Row label="Shadow">
            <Slider value={t.shadow * 100} min={0} max={100} onChange={(v) => set({ shadow: v / 100 }, `shadow:${clip.id}`)} />
            <span className="w-10 shrink-0 text-right text-xs text-fg-3 tabular">{Math.round(t.shadow * 100)}</span>
          </Row>
        </div>
      </Section>
    </>
  )
}
