/**
 * Colour correction and relighting for agents: automatic white balance and
 * levels, matching shots to a reference, and a new light shaped by an
 * on-device depth map. The creative grade and the light effects themselves go
 * through clip_update (color) and effect_add.
 */
import { getProject } from '@/editor/store'
import { autoColor, matchColor } from '@/project/color-actions'
import { relightClip } from '@/project/depth'
import { bool, clipById, list, num, number, obj, str, strings, text, type AgentTool } from './kit'

const round = (v: number) => Math.round(v * 1000) / 1000

export const COLOR_TOOLS: AgentTool[] = [
  {
    name: 'auto_color',
    description: [
      'Colour-correct video or image clips automatically, each on its own: a white balance that takes the light’s colour cast out (gains per channel in linear light, so whites go white) and levels that set black and white points with a gentle midtone.',
      'Measured from the footage as it came in, before any grade; written to color.balance and color.levels (the correction stage, which runs before the creative grade). One undo step.',
      'Do this first, then grade the look on top (clip_update color: exposure, contrast, wheels, curves, hsl, lut). Fine-tune with clip_update color.balance { r, g, b } or color.levels { black, white, gamma }; null removes either.',
      'It is careful with mood (a sunset stays warm); for a deliberately coloured scene, use white_balance false.',
    ].join(' '),
    inputSchema: obj(
      {
        clip_ids: list('Video or image clips to correct', { type: 'string' }),
        white_balance: bool('Take out the colour cast (default true)'),
        levels: bool('Set the black and white points (default true)'),
      },
      ['clip_ids'],
    ),
    run: async (a) => {
      const ids = strings(a, 'clip_ids')
      if (!ids.length) throw new Error('clip_ids is empty — give the video or image clips to correct.')
      ids.forEach(clipById)
      const res = await autoColor(ids, { balance: a.white_balance !== false, levels: a.levels !== false, source: 'ai' })
      return {
        corrected: res.map((r) => ({ clip_id: r.clipId, ...(r.balance ? { balance: r.balance } : {}), ...(r.levels ? { levels: r.levels } : {}) })),
        note: 'Check the result with get_frame. The creative grade applies on top of this correction.',
      }
    },
  },
  {
    name: 'match_color',
    description: [
      'Match clips to a reference shot so they cut together: each clip’s footage is lined up with how the reference looks after its own correction — shadows, midtones, highlights and colour cast — as per-channel curves in color.match (the correction stage). The match replaces each clip’s own balance and levels.',
      'copy_look true also copies the reference’s creative grade (exposure, contrast, saturation, temperature, tint, vignette, wheels, curves, HSL, LUT), for shots of one scene. One undo step.',
      'Returns how far each clip was from the reference before and after (0 = identical tone and colour). Correct the reference first (auto_color) so the others follow a good shot.',
    ].join(' '),
    inputSchema: obj(
      {
        clip_ids: list('Clips to match', { type: 'string' }),
        reference_id: str('The clip to match them to'),
        copy_look: bool('Also copy the reference’s creative grade (default false)'),
      },
      ['clip_ids', 'reference_id'],
    ),
    run: async (a) => {
      const ids = strings(a, 'clip_ids')
      const ref = text(a, 'reference_id') ?? ''
      clipById(ref)
      ids.forEach(clipById)
      const res = await matchColor(ids, ref, { copyLook: a.copy_look === true, source: 'ai' })
      return { reference_id: ref, matched: res.map((r) => ({ clip_id: r.clipId, distance_before: round(r.before), distance_after: round(r.after) })) }
    },
  },
  {
    name: 'relight_clip',
    description: [
      'Relight a video or image clip: add a point light, or change where the light comes from. Lumen first makes the clip’s depth map on this computer (Depth Anything, downloaded once; about the clip’s length on a GPU, several times that on the CPU; reused afterwards), then adds the Relight effect shaped by it — surfaces turn toward or away from the light and near things catch more of it. One undo step.',
      'x, y place the light as fractions of the frame (beyond 0..1 is off the frame); height 0–100 (low rakes across surfaces, high lights from the front); ambient 0–100 is how much of the existing light stays (lower it to make the new light the key light — e.g. 45 to move the light from one side to the other); color is the light’s colour; amount 0–100 its strength.',
      'depth false skips the depth map (the light is shaped from the picture’s brightness — quicker, flatter). Adjust later with effect_update (params x, y, height, reach, ambient, soft, shine, color). Check with get_frame.',
    ].join(' '),
    inputSchema: obj(
      {
        clip_id: str('The video or image clip'),
        x: num('Light position across, fraction of the frame (default 0.25)'),
        y: num('Light position down, fraction of the frame (default 0.3)'),
        height: num('0–100: low rakes across, high lights from the front (default 45)'),
        ambient: num('0–100: how much of the existing light stays (default 75)'),
        color: str('The light’s colour, "#rrggbb" (default warm white)'),
        amount: num('0–100: strength of the new light (default 60)'),
        depth: bool('Make a depth map so the light follows the shapes (default true)'),
      },
      ['clip_id'],
    ),
    run: async (a, ctx) => {
      const clipId = text(a, 'clip_id') ?? ''
      clipById(clipId)
      const params: Record<string, number | string> = {}
      for (const key of ['x', 'y', 'height', 'ambient'] as const) {
        const v = number(a, key)
        if (v !== undefined) params[key] = v
      }
      const color = text(a, 'color')
      if (color) {
        if (!/^#[\da-f]{6}$/i.test(color)) throw new Error('color is "#rrggbb", e.g. "#ffd2a0" for warm light.')
        params.color = color
      }
      const res = await relightClip(clipId, {
        params,
        amount: number(a, 'amount'),
        depth: a.depth !== false,
        source: 'ai',
        signal: ctx?.signal,
        onProgress: (p) => p.total && ctx?.progress?.(`Depth map ${Math.round((p.done / p.total) * 100)}% — frame ${p.done} of ${p.total}`),
      })
      const fx = getProject().clips[clipId]?.effects.find((e) => e.kind === 'relight')
      return { clip_id: clipId, effect_id: fx?.id, depth_map: res.depth, params: fx?.params }
    },
  },
]
