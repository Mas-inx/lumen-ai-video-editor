/**
 * Directing a video: the storyboard it's planned in (read here; changed with
 * the storyboard_* commands), styles that set type, composition, motion and
 * finish in one step, the brand kit that keeps every project on-brand, and
 * B-roll found by meaning among the media already in the project.
 */
import { rankBroll, scriptSentences, sentencesOf, type BrollLine } from '@/editor/broll'
import { voiceClips, timelineTranscript } from '@/editor/smart'
import { allSequences } from '@/editor/sequences'
import { getProject } from '@/editor/store'
import { plannedSeconds, SCENE_TREATMENTS, sceneClips, sceneRange, sceneStarts } from '@/editor/storyboard'
import { applyStyle, describeStyle, STYLE_IDS, STYLE_PARTS, STYLES, styleById, styleToApply, type StylePart, type StylePlan } from '@/editor/styles'
import type { Project, ProjectBrand, StoryboardScene } from '@/editor/types'
import { useUI } from '@/editor/ui-store'
import { fontLabel } from '@/engine/fonts'
import { applyBrandKit, BRAND_PARTS, findKit, kitFontName, loadBrandKits, type BrandPart } from '@/project/brand'
import type { BrandKit } from '@shared/brand'
import { bool, clampNum, int, list, num, number, obj, oneOf, str, strings, text, type AgentTool } from './kit'

const round = (v: number, digits = 2) => Math.round(v * 10 ** digits) / 10 ** digits

function sceneById(p: Project, id: string): { scene: StoryboardScene; n: number } {
  const scenes = p.storyboard?.scenes ?? []
  const n = scenes.findIndex((s) => s.id === id)
  if (n < 0) {
    const known = scenes.slice(0, 10).map((s, i) => `${s.id} (${i + 1}. ${s.title || 'untitled'})`)
    throw new Error(`No scene “${id}” in the storyboard.${known.length ? ` Scenes: ${known.join(', ')}.` : ' It has no scenes yet — plan them with storyboard_addScenes.'}`)
  }
  return { scene: scenes[n], n }
}

/** A scene as the AI reads it: its plan, and where it is on the timeline now. */
function sceneLine(p: Project, scene: StoryboardScene, n: number, startsAt: number) {
  const range = sceneRange(p, scene)
  const timelines = allSequences(p)
  const media = scene.assetIds.map((id) => p.assets[id]).filter(Boolean)
  return {
    n: n + 1,
    id: scene.id,
    title: scene.title,
    status: scene.status,
    treatment: scene.treatment,
    seconds: scene.seconds,
    starts_at_seconds: round(startsAt),
    script: scene.script,
    transition_in: scene.transition ? { kind: scene.transition.kind, seconds: scene.transition.seconds } : 'cut',
    ...(scene.needs.length ? { needs: scene.needs } : {}),
    ...(media.length ? { media: media.map((a) => ({ asset_id: a.id, name: a.name, kind: a.kind })) } : {}),
    ...(scene.notes ? { notes: scene.notes } : {}),
    ...(range
      ? {
          produced: {
            timeline_id: range.timelineId,
            timeline: timelines.find((t) => t.id === range.timelineId)?.name,
            ...(range.open ? {} : { not_open: true }),
            from_seconds: round(range.from / range.fps),
            to_seconds: round(range.to / range.fps),
            seconds: round((range.to - range.from) / range.fps),
            ...(range.clipIds.length ? { clip_ids: range.clipIds } : {}),
          },
        }
      : scene.produced
        ? { produced: { timeline_id: scene.produced.timelineId, missing: 'That timeline is gone.' } }
        : {}),
  }
}

/** The clips a style step touched, to show the user what the AI changed. */
function touched(plan: StylePlan) {
  const ids = new Set<string>()
  for (const s of plan.steps) {
    const input = s.input as { ids?: string[]; id?: string; clipId?: string }
    for (const id of [...(input.ids ?? []), input.id, input.clipId]) if (id) ids.add(id)
  }
  return [...ids]
}

function scopeIds(a: Record<string, unknown>, p: Project): string[] | undefined {
  const ids = strings(a, 'clip_ids')
  const sceneId = text(a, 'scene_id')
  if (sceneId) {
    const { scene, n } = sceneById(p, sceneId)
    const clips = sceneClips(p, scene)
    if (!clips.length) throw new Error(`Scene ${n + 1} (“${scene.title || 'untitled'}”) isn’t on the open timeline yet — produce it, then record its clips with storyboard_updateScene → produced.clipIds.`)
    return clips.map((c) => c.id)
  }
  if (!ids.length) return undefined
  const missing = ids.filter((id) => !p.clips[id])
  if (missing.length === ids.length) throw new Error(`None of those clips exist (${missing.join(', ')}). Call get_project for current ids.`)
  return ids.filter((id) => p.clips[id])
}

function brandLine(p: Project, b: ProjectBrand) {
  return {
    name: b.name,
    ...(b.kitId ? { kit_id: b.kitId } : {}),
    colors: b.colors,
    fonts: { heading: { ref: b.fonts.heading, name: fontLabel(b.fonts.heading, p) }, body: { ref: b.fonts.body, name: fontLabel(b.fonts.body, p) } },
    logos: b.logoAssetIds.map((id) => ({ asset_id: id, name: p.assets[id]?.name })).filter((l) => l.name),
    titles: b.titles,
    captions: b.captions,
    look: b.look,
    motion: b.motion,
    style: b.style,
  }
}

function kitLine(kit: BrandKit) {
  const font = (f: BrandKit['fonts']['heading']) => ('builtin' in f ? { builtin: f.builtin, name: kitFontName(f) } : { name: f.name, file: f.fileName, note: 'apply_brand_kit embeds it in the project' })
  return {
    id: kit.id,
    name: kit.name,
    colors: kit.colors,
    fonts: { heading: font(kit.fonts.heading), body: font(kit.fonts.body) },
    logos: kit.logos.map((l) => ({ id: l.id, name: l.name, path: l.path, ...(l.width ? { size: `${l.width}x${l.height}` } : {}) })),
    titles: kit.titles,
    captions: kit.captions,
    look: kit.look,
    motion: kit.motion,
    style: kit.style,
    watermark: kit.watermark,
  }
}

export const CREATIVE_TOOLS: AgentTool[] = [
  {
    name: 'get_storyboard',
    description:
      'The storyboard — the plan this video is produced from: its title, brief and style, and every scene in order — number, id, title, status, treatment, target seconds and where it starts in the plan, script, transition in, needs, linked media, notes and, once produced, where it is on the timeline now (it follows its clips through later edits). With totals. Plan and change it with storyboard_update, storyboard_addScenes, storyboard_updateScene, storyboard_moveScene and storyboard_removeScenes.',
    inputSchema: obj({ scene_id: str('Only this scene') }),
    run: async (a) => {
      const p = getProject()
      const sb = p.storyboard
      if (!sb?.scenes.length && !sb?.brief) return { scenes: [], note: 'There’s no storyboard yet. Plan one: storyboard_update (brief, style), then storyboard_addScenes — and let the user review it before producing.' }
      const starts = sceneStarts(sb)
      const lines = sb.scenes.map((s, i) => sceneLine(p, s, i, starts[i]))
      if (text(a, 'scene_id')) {
        const { n } = sceneById(p, text(a, 'scene_id')!)
        return lines[n]
      }
      const style = sb.style ? (styleById(sb.style)?.name ?? (sb.style === 'brand' ? p.brand?.name : undefined)) : undefined
      return {
        ...(sb.title ? { title: sb.title } : {}),
        ...(sb.brief ? { brief: sb.brief } : {}),
        ...(sb.style ? { style: sb.style, ...(style ? { style_name: style } : {}) } : {}),
        planned_seconds: round(plannedSeconds(sb)),
        scenes: lines,
        done: sb.scenes.filter((s) => s.status === 'done').length,
        produced: lines.filter((l) => 'produced' in l).length,
        treatments: SCENE_TREATMENTS.map((t) => t.id),
      }
    },
  },
  {
    name: 'list_styles',
    description:
      'The styles apply_style puts on a timeline. Each is more than a colour look: title typography (font, weight, case, tracking, size), where titles sit and how they move in and out, the caption style, the transition on cuts, the look, finishing effects and camera move on footage, pacing (shot lengths, cutting on the beat) and the render_motion_graphic settings that match. Also says which style the storyboard and the brand use.',
    inputSchema: obj({ style_id: oneOf('Just this one', STYLE_IDS) }),
    run: async (a) => {
      const p = getProject()
      const only = text(a, 'style_id')
      const styles = (only ? STYLES.filter((s) => s.id === only) : STYLES).map(describeStyle)
      return {
        styles,
        ...(p.storyboard?.style ? { storyboard_style: p.storyboard.style } : {}),
        ...(p.brand ? { brand: { name: p.brand.name, builds_on: p.brand.style, note: 'apply_style keeps the brand’s typefaces and colours (keep_brand); style_id "brand" applies the brand on its own style.' } } : {}),
      }
    },
  },
  {
    name: 'apply_style',
    description:
      'Apply a style from list_styles as ONE undo step: titles take its typography, place and in/out animations; captions its caption style; cuts between shots its transition (or straight cuts); footage its look, finishing effects and camera move. To the whole open timeline, or just clip_ids or a storyboard scene’s clips. Effects and camera moves of a style applied before are swapped out; effects and motion added by hand are kept. A project with a brand keeps its typefaces and colours unless keep_brand is false; style_id "brand" applies the brand on its own style.',
    inputSchema: obj(
      {
        style_id: oneOf('The style', [...STYLE_IDS, 'brand']),
        clip_ids: list('Only these clips (default: the whole open timeline)', { type: 'string' }, { maxItems: 500 }),
        scene_id: str('Only the clips of this storyboard scene'),
        include: list('Which parts (default all)', { type: 'string', enum: STYLE_PARTS }),
        keep_brand: bool('Keep the project brand’s typefaces and colours (default true)'),
      },
      ['style_id'],
    ),
    run: async (a) => {
      const id = text(a, 'style_id') ?? ''
      const p = getProject()
      const spec = styleToApply(p, id, a.keep_brand !== false)
      if (!spec) throw new Error(id === 'brand' ? 'This project has no brand yet — apply_brand_kit first.' : `There’s no style “${id}”. Styles: ${STYLE_IDS.join(', ')}.`)
      const clipIds = scopeIds(a, p)
      const parts = strings(a, 'include').filter((x): x is StylePart => (STYLE_PARTS as string[]).includes(x))
      const plan = applyStyle(spec, { clipIds, parts, source: 'ai' })
      if (!plan.steps.length) throw new Error(`Nothing to style${clipIds ? ' in those clips' : ' on the timeline'}: no titles, captions, cuts or footage${plan.skipped.length ? ` (${plan.skipped.join('; ')})` : ''}.`)
      useUI.getState().markAiTouched(touched(plan))
      return {
        applied: spec.name,
        titles: plan.counts.titles,
        captions: plan.counts.captions,
        cuts: plan.counts.cuts,
        footage: plan.counts.footage,
        ...(plan.skipped.length ? { left_alone: plan.skipped } : {}),
        pacing: spec.pacing.notes,
        undo: 'One step in History.',
      }
    },
  },
  {
    name: 'suggest_broll',
    description:
      'Find B-roll already in the project for what is said — do this before generating anything new. Matches each sentence of the speech on the timeline (from_seconds / to_seconds), or of `text`, or of a storyboard scene’s script, against everything the project knows about its video and stills: names, tags, descriptions, file and folder names, generation prompts, cue sheets and transcripts — by word stems and related words, rare words counting most. Returns ranked candidates per sentence (score 0–1, the words that matched, where), a varied pick for each, and the moment to use when the match is in something said or cued in the media. Media with nothing to go on is listed as undescribed: look at it (get_media_frames), describe it (asset_update → description) and ask again. Generate only for sentences with no good candidate.',
    inputSchema: obj({
      text: str('Sentences to match instead of the timeline’s speech (a script, a voice-over draft)'),
      scene_id: str('Match this storyboard scene’s script'),
      from_seconds: num('Timeline speech from here', { minimum: 0 }),
      to_seconds: num('Timeline speech up to here', { minimum: 0 }),
      per_sentence: int('Candidates per sentence (1–10, default 3)', { minimum: 1, maximum: 10 }),
      kind: oneOf('Only video or only stills', ['video', 'image']),
      unused_only: bool('Only media that isn’t on the timeline yet'),
    }),
    run: async (a) => {
      const p = getProject()
      let lines: BrollLine[]
      let from: 'text' | 'scene' | 'timeline' = 'timeline'
      if (text(a, 'text')) {
        lines = scriptSentences(text(a, 'text')!)
        from = 'text'
      } else if (text(a, 'scene_id')) {
        const { scene, n } = sceneById(p, text(a, 'scene_id')!)
        if (!scene.script.trim()) throw new Error(`Scene ${n + 1} has no script to match — give it one (storyboard_updateScene) or pass text.`)
        lines = scriptSentences(scene.script)
        from = 'scene'
      } else {
        const lo = number(a, 'from_seconds') ?? 0
        const hi = number(a, 'to_seconds') ?? Infinity
        lines = sentencesOf(timelineTranscript(p, lo, hi))
        if (!lines.length) throw new Error('Nothing said on the timeline is transcribed there — call transcribe_media (or add_captions) first, or pass text.')
      }
      if (!lines.length) throw new Error('No words to match — the text is empty.')
      const cut = lines.length > 80
      const kind = text(a, 'kind') as 'video' | 'image' | undefined
      // On the timeline, the footage of whoever speaks isn't B-roll for their own words.
      const exclude = from === 'timeline' ? voiceClips(p).map((c) => c.assetId!).filter(Boolean) : []
      const r = rankBroll(p, lines.slice(0, 80), { perLine: Math.round(clampNum(number(a, 'per_sentence') ?? 3, 1, 10)), kinds: kind ? [kind] : undefined, unusedOnly: a.unused_only === true, exclude })
      if (!r.considered) throw new Error('There’s no video or still in the project to use as B-roll — import some, or generate it.')
      return {
        sentences: r.suggestions.map((s) => ({
          ...(s.line.start !== undefined ? { start_seconds: round(s.line.start), end_seconds: round(s.line.end ?? s.line.start) } : {}),
          text: s.line.text,
          candidates: s.candidates.map((c) => ({
            asset_id: c.assetId,
            name: c.name,
            kind: c.kind,
            score: c.score,
            matched: c.matched,
            found_in: c.fields,
            ...(c.at ? { source_seconds: [c.at.start, c.at.end], there: c.at.text } : {}),
            on_timeline: c.onTimeline,
          })),
          ...(s.pick ? { pick: s.pick } : {}),
        })),
        media_considered: r.considered,
        sentences_without_match: r.suggestions.filter((s) => !s.candidates.length).length,
        ...(r.undescribed.length ? { undescribed: r.undescribed.slice(0, 20).map((id) => ({ asset_id: id, name: p.assets[id]?.name })), undescribed_count: r.undescribed.length } : {}),
        ...(cut ? { note: `Matched the first 80 of ${lines.length} sentences — ask again with from_seconds for the rest.` } : {}),
      }
    },
  },
  {
    name: 'get_brand_kit',
    description:
      'The brand: the project’s own (what apply_brand_kit gave it) and the brand kits kept in Lumen for every project — named colours, heading and body typefaces, logos (image files you can import), title and caption styles, look, motion rules (title animations, easing, transitions), the style it builds on and the corner logo. Use the brand’s fonts, colours and motion in every title, graphic and generated asset, so every scene and every project looks like the same brand.',
    inputSchema: obj({ kit_id: str('A kit (default: the active one)') }),
    run: async (a) => {
      const store = await loadBrandKits()
      const p = getProject()
      const kit = findKit(text(a, 'kit_id'))
      if (text(a, 'kit_id') && !kit) throw new Error(`No brand kit “${text(a, 'kit_id')}”. Kits: ${store.kits.map((k) => `${k.id} (${k.name})`).join(', ') || 'none'}.`)
      return {
        project_brand: p.brand ? brandLine(p, p.brand) : null,
        kits: store.kits.map((k) => ({ id: k.id, name: k.name, ...(k.id === store.activeId ? { active: true } : {}) })),
        ...(kit ? { kit: kitLine(kit) } : {}),
        note: !store.kits.length
          ? 'There are no brand kits yet — the user makes them in Styles › Brand kit.'
          : p.brand
            ? 'apply_style keeps this brand’s typefaces and colours; apply_brand_kit applies a kit again.'
            : 'This project has no brand yet — apply_brand_kit gives it one.',
      }
    },
  },
  {
    name: 'apply_brand_kit',
    description:
      'Apply a brand kit (get_brand_kit; default: the active one) to the project as ONE undo step: its fonts are embedded, its logos come in as media, the project gets the brand (brand_set) — then the open timeline, or clip_ids, takes its house style: titles its typefaces, colours, case and title motion; captions its caption style and accent; cuts its transition; footage its look, on top of the style it builds on; and with "logo" its logo goes in its corner. Everything stays editable.',
    inputSchema: obj({
      kit_id: str('A kit (default: the active one)'),
      clip_ids: list('Only these clips (default: the whole open timeline)', { type: 'string' }, { maxItems: 500 }),
      include: list('Which parts (default all)', { type: 'string', enum: BRAND_PARTS }),
    }),
    run: async (a) => {
      const p = getProject()
      const clipIds = scopeIds(a, p)
      const parts = strings(a, 'include').filter((x): x is BrandPart => (BRAND_PARTS as string[]).includes(x))
      const r = await applyBrandKit({ kitId: text(a, 'kit_id'), clipIds, parts, source: 'ai' })
      useUI.getState().markAiTouched([...touched(r.plan), ...(r.logoClipId ? [r.logoClipId] : [])])
      const after = getProject()
      return {
        brand: r.brand.name,
        fonts: { heading: fontLabel(r.brand.fonts.heading, after), body: fontLabel(r.brand.fonts.body, after) },
        ...(r.brand.style ? { builds_on: r.brand.style } : {}),
        titles: r.plan.counts.titles,
        captions: r.plan.counts.captions,
        cuts: r.plan.counts.cuts,
        footage: r.plan.counts.footage,
        ...(r.logoClipId ? { logo_clip_id: r.logoClipId } : {}),
        ...(r.brand.logoAssetIds.length ? { logo_asset_ids: r.brand.logoAssetIds } : {}),
        ...(r.plan.skipped.length || r.notes.length ? { notes: [...r.plan.skipped, ...r.notes] } : {}),
        undo: 'One step in History.',
      }
    },
  },
]
