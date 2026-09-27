/**
 * The tools every AI brain gets — the Copilot's models, local Claude Code / Codex
 * and external agents over MCP: every editor command (the same typed commands
 * the UI dispatches), eyes and ears on the project (tools/vision, tools/inspect),
 * editor control (tools/control), plus the Blender / HyperFrames / media integrations.
 */
import type { BridgeToolResult, Job } from '@shared/integrations'
import { commands, toolDefinitions, type CommandName } from '@/editor/commands'
import { clipEnd, projectDuration } from '@/editor/ops'
import { placeAsset } from '@/editor/placement'
import { playback, usePlayback } from '@/editor/playback'
import { dispatch, getProject } from '@/editor/store'
import { useUI } from '@/editor/ui-store'
import { addCaptions, duckMusic, findPauses, reframe, removePauses, silentCuts, untranscribed } from '@/editor/smart'
import { SFX } from '@/engine/sfx'
import { desktop } from '@/lib/platform'
import { sfxAsset } from '@/project/audio-library'
import { importMediaFiles } from '@/project/media-import'
import { isDirty, useSession } from '@/project/session'
import { canTranscribe, ensureTranscripts, transcribeMedia, transcribers, type Transcriber } from '@/project/transcribe'
import { useAi } from './ai'
import { requestApproval } from './approvals'
import { api, elevenMusic, elevenSfx, elevenSpeak, generateImage, generateVideo, importLink, loadGenModels, renderBlender, renderMotion, useGenModels, useIntegrations, type GenProvider } from './store'
import { CONTROL_TOOLS } from './tools/control'
import { emitToolImages } from './tools/events'
import { INSPECT_TOOLS } from './tools/inspect'
import { bool, num, obj, str, WithImages, type AgentTool } from './tools/kit'
import { VISION_TOOLS } from './tools/vision'

const PLACE = bool('Put the finished clip on the timeline at the playhead (default true).')
const WAIT = num('Seconds to wait for the render before returning (default 90, max 600). If it is still running, poll get_job.', { minimum: 0, maximum: 600 })
const AT = num('Where to place it, in seconds from the start of the timeline (default: the playhead).', { minimum: 0 })

// ─── Jobs ────────────────────────────────────────────────────────────────

function waitForJob(jobId: string, seconds: number): Promise<Job | undefined> {
  const done = () => {
    const s = useIntegrations.getState()
    const job = s.jobs[jobId]
    // Finished and, if it made media, imported into the project.
    return job && job.status !== 'running' && (job.status !== 'done' || !job.assets?.length || (s.imported[jobId]?.length ?? 0) >= job.assets.length) ? job : undefined
  }
  const now = done()
  if (now || seconds <= 0) return Promise.resolve(now ?? useIntegrations.getState().jobs[jobId])
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      unsub()
      resolve(useIntegrations.getState().jobs[jobId])
    }, seconds * 1000)
    const unsub = useIntegrations.subscribe(() => {
      const job = done()
      if (!job) return
      clearTimeout(timer)
      unsub()
      resolve(job)
    })
  })
}

function jobReport(job: Job | undefined, placedClip?: string | null) {
  if (!job) return { status: 'unknown' }
  const assetIds = useIntegrations.getState().imported[job.id] ?? []
  return {
    job_id: job.id,
    status: job.status,
    progress: job.progress >= 0 ? Math.round(job.progress * 100) / 100 : null,
    message: job.message,
    error: job.error,
    asset_ids: assetIds,
    ...(placedClip ? { clip_id: placedClip } : {}),
    ...(job.result ? { text: job.result.text.join('\n').slice(0, 4000), links: job.result.links } : {}),
  }
}

/** Starts a render, optionally waits for it, and places the result. */
async function runJob(start: () => Promise<Job>, args: Record<string, unknown>) {
  const at = typeof args.at_seconds === 'number' ? Math.round(args.at_seconds * getProject().settings.fps) : usePlayback.getState().frame
  const job = await start()
  const wait = Math.min(600, Math.max(0, typeof args.wait_seconds === 'number' ? args.wait_seconds : 90))
  const finished = await waitForJob(job.id, wait)
  let clip: string | null = null
  if (finished?.status === 'done' && args.place !== false) {
    const [assetId] = useIntegrations.getState().imported[job.id] ?? []
    if (assetId) clip = placeAsset(assetId, at, { source: 'ai' })
  } else if (finished?.status === 'running' && args.place !== false) {
    placeWhenDone(job.id, at)
  }
  return jobReport(finished, clip)
}

/** Starts a render and drops the result on the timeline at `at` once it lands (Copilot uses this). */
export async function startAndPlace(start: () => Promise<Job>, at: number) {
  const job = await start()
  placeWhenDone(job.id, at)
  return job
}

/** For renders still going when the tool returned: drop the clip in once it lands. */
function placeWhenDone(jobId: string, at: number) {
  void waitForJob(jobId, 30 * 60).then((job) => {
    const [assetId] = useIntegrations.getState().imported[jobId] ?? []
    if (job?.status === 'done' && assetId) placeAsset(assetId, at, { source: 'ai' })
  })
}

// ─── Project summary ─────────────────────────────────────────────────────

function projectSummary() {
  const p = getProject()
  const fps = p.settings.fps
  const clipsOn = (trackId: string) =>
    Object.values(p.clips)
      .filter((c) => c.trackId === trackId)
      .sort((a, b) => a.start - b.start)
      .map((c) => ({
        id: c.id,
        name: c.name,
        kind: c.kind,
        start: c.start,
        end: clipEnd(c),
        duration: c.duration,
        ...(c.assetId ? { asset_id: c.assetId } : {}),
        ...(c.text ? { text: c.text.content } : {}),
        ...(c.effects.length ? { effects: c.effects.map((e) => e.kind) } : {}),
        ...(c.transitionIn ? { transition_in: c.transitionIn.kind } : {}),
        ...(c.groupId ? { group: c.groupId } : {}),
        ...(c.freeze ? { freeze_frame: true } : {}),
        ...(c.audio.detached ? { sound_detached: true } : {}),
        ...(c.keyframes.speed?.length ? { speed_ramp: true } : c.speed !== 1 ? { speed: c.speed } : {}),
        ...(c.reverse ? { reverse: true } : {}),
        ...(c.crop ? { cropped: true } : {}),
      }))
  const duration = projectDuration(p)
  return {
    name: p.name,
    file: useSession.getState().path,
    unsaved_changes: isDirty(),
    settings: p.settings,
    duration_frames: duration,
    duration_seconds: Math.round((duration / fps) * 100) / 100,
    playhead_frame: usePlayback.getState().frame,
    playing: usePlayback.getState().playing,
    selection: useUI.getState().selection,
    ...(p.range ? { in_out: { in: p.range.in, out: p.range.out } } : {}),
    ...(p.master ? { master_mix: p.master } : {}),
    tracks: p.tracks.map((t) => ({ id: t.id, name: t.name, kind: t.kind, role: t.role, locked: t.locked, hidden: t.hidden, ...(t.muted ? { muted: true } : {}), ...(t.solo ? { solo: true } : {}), ...(t.mix ? { mix: t.mix } : {}), clips: clipsOn(t.id) })),
    media: Object.values(p.assets).map((a) => ({
      id: a.id,
      name: a.name,
      kind: a.kind,
      duration_seconds: a.duration,
      ...(a.width ? { size: `${a.width}x${a.height}` } : {}),
      ...(a.alpha ? { alpha: true } : {}),
      ...(a.kind === 'video' && a.hasAudio === false ? { silent: true } : {}),
      ...(a.transcript?.length ? { transcribed: true } : {}),
      ...(a.source.missing ? { offline: true } : {}),
      ...(a.source.type === 'file' && a.source.path ? { path: a.source.path } : {}),
      ...(a.generated ? { generated_by: a.provenance?.integration ?? 'ai' } : {}),
    })),
    markers: p.markers.map((m) => ({ id: m.id, frame: m.frame, label: m.label, color: m.color })),
  }
}

// ─── Generation helpers ──────────────────────────────────────────────────

function projectAspect(): '16:9' | '9:16' | '1:1' {
  const { width, height } = getProject().settings
  return width > height * 1.1 ? '16:9' : height > width * 1.1 ? '9:16' : '1:1'
}

/** A connected provider + model that can make this kind of media. */
async function pickGenerator(kind: 'image' | 'video', provider: unknown, model: unknown): Promise<{ provider: GenProvider; model: string }> {
  const providers = useAi.getState().providers
  const candidates = (['openai', 'gemini'] as const).filter((p) => providers[p]?.configured && (!provider || provider === p))
  if (!candidates.length) throw new Error(`No ${kind} generator is connected. Add an OpenAI or Google Gemini API key in Integrations › AI models.`)
  for (const p of candidates) {
    await loadGenModels(p)
    const list = useGenModels.getState().models[p]?.[kind] ?? []
    const chosen = typeof model === 'string' && model ? (list.includes(model) ? model : list.length ? null : model) : list[0]
    if (chosen) return { provider: p, model: chosen }
  }
  throw new Error(`The connected keys don’t have access to a ${kind} model${typeof model === 'string' ? ` called ${model}` : ''}.`)
}

// ─── Tools ───────────────────────────────────────────────────────────────

const MATERIALS = ['chrome', 'gold', 'glass', 'plastic', 'neon', 'clay', 'matte']

const INTEGRATION_TOOLS: AgentTool[] = [
  {
    name: 'get_project',
    description: 'Everything about the open project: settings (fps!), tracks with their clips (frames), media library, markers, playhead and selection. Call this before editing.',
    inputSchema: obj({}),
    run: async () => projectSummary(),
  },
  {
    name: 'place_asset',
    description: 'Put a media item (from get_project → media) on the timeline. Footage goes on the main story track; transparent overlays go on a track above.',
    inputSchema: obj({ asset_id: str('Media id'), at_seconds: AT, track_id: str('Optional track to use') }, ['asset_id']),
    run: async (a) => {
      const at = typeof a.at_seconds === 'number' ? Math.round(a.at_seconds * getProject().settings.fps) : usePlayback.getState().frame
      const clip = placeAsset(String(a.asset_id), at, { source: 'ai', trackId: typeof a.track_id === 'string' ? a.track_id : undefined })
      if (!clip) throw new Error('Couldn’t place that media — check the asset id.')
      return { clip_id: clip }
    },
  },
  {
    name: 'seek',
    description: 'Move the playhead (what the user sees in the viewer).',
    inputSchema: obj({ seconds: num('Time in seconds', { minimum: 0 }) }, ['seconds']),
    run: async (a) => {
      playback.seek(Math.round(Number(a.seconds) * getProject().settings.fps))
      return { playhead_frame: usePlayback.getState().frame }
    },
  },
  {
    name: 'render_3d_title',
    description: 'Render a real 3D title in Blender (extruded, bevelled, studio-lit, motion-blurred, transparent background) and add it to the project. Needs Blender installed.',
    inputSchema: obj(
      {
        text: str('The title text'),
        material: str('Surface', { enum: MATERIALS }),
        color: str('Hex colour for plastic / neon / clay / matte, e.g. #ff5a36'),
        font: str('Typeface', { enum: ['sans', 'display', 'serif', 'serif-italic'] }),
        motion: str('Intro move', { enum: ['spin', 'rise', 'slam', 'orbit', 'float'] }),
        depth: num('Extrusion depth 0–1 (default 0.35)', { minimum: 0, maximum: 1 }),
        duration_seconds: num('Clip length (default 4)', { minimum: 0.5, maximum: 20 }),
        quality: str('Render quality', { enum: ['draft', 'standard', 'high'] }),
        place: PLACE,
        at_seconds: AT,
        wait_seconds: WAIT,
      },
      ['text'],
    ),
    run: (a) =>
      runJob(
        () =>
          renderBlender({
            template: 'title3d',
            params: { text: a.text, material: a.material ?? 'chrome', color: a.color, font: a.font ?? 'sans', motion: a.motion ?? 'spin', depth: a.depth ?? 0.35 },
            duration: Number(a.duration_seconds ?? 4),
            quality: (a.quality as 'draft') ?? 'standard',
            prompt: String(a.text),
          }),
        a,
      ),
  },
  {
    name: 'render_3d_background',
    description: 'Render a seamless-looping abstract 3D background in Blender (glossy forms, depth of field) and add it to the project.',
    inputSchema: obj({
      palette: str('Colours', { enum: ['aurora', 'sunset', 'candy', 'ocean', 'mono'] }),
      style: str('Shapes', { enum: ['mix', 'blobs', 'rings', 'cubes'] }),
      background: str('Hex background colour (default near-black)'),
      speed: num('Loops per clip, 1–3 (default 1)', { minimum: 1, maximum: 3 }),
      duration_seconds: num('Clip length (default 8)', { minimum: 1, maximum: 30 }),
      quality: str('Render quality', { enum: ['draft', 'standard', 'high'] }),
      place: PLACE,
      at_seconds: AT,
      wait_seconds: WAIT,
    }),
    run: (a) =>
      runJob(
        () =>
          renderBlender({
            template: 'shapes',
            params: { palette: a.palette ?? 'aurora', style: a.style ?? 'mix', background: a.background, speed: a.speed ?? 1 },
            duration: Number(a.duration_seconds ?? 8),
            quality: (a.quality as 'draft') ?? 'standard',
            transparent: false,
          }),
        a,
      ),
  },
  {
    name: 'render_blender_script',
    description: `Render any Blender scene you write in Python (bpy) and add it to the project. The script runs once on an empty scene at the project's size and fps; build objects, materials, lights and camera. Define animate(t, frame) to animate per frame (t in seconds), or insert keyframes yourself. Helpers in scope: scene, P, W, H, FPS, FRAMES, DURATION, hex_color, principled(name, color, metallic, roughness, coat, emission, strength, transmission), material_preset('chrome'|'gold'|'glass'|'neon'|'plastic', hex), studio_world(), add_camera(location, target, lens), add_light(kind, location, energy, size), look_at(obj, target), load_font('sans'|'display'|'serif'), ease_out_cubic, ease_in_out, ease_out_back, lerp. The user must approve the script in Lumen before it runs.`,
    inputSchema: obj(
      {
        script: str('Python (bpy) source'),
        description: str('One line telling the user what the scene is'),
        duration_seconds: num('Clip length (default 4)', { minimum: 0.1, maximum: 30 }),
        transparent: bool('Transparent background (default true)'),
        quality: str('Render quality', { enum: ['draft', 'standard', 'high'] }),
        place: PLACE,
        at_seconds: AT,
        wait_seconds: WAIT,
      },
      ['script', 'description'],
    ),
    run: async (a) => {
      const ok = await requestApproval({ title: 'Render an AI-written Blender scene?', detail: String(a.description), code: String(a.script), requester: 'An AI agent' })
      if (!ok) throw new Error('The user declined to run this script.')
      return runJob(
        () =>
          renderBlender({
            template: 'script',
            params: {},
            script: String(a.script),
            name: String(a.description).slice(0, 60),
            duration: Number(a.duration_seconds ?? 4),
            quality: (a.quality as 'draft') ?? 'standard',
            transparent: a.transparent !== false,
            prompt: String(a.description),
          }),
        a,
      )
    },
  },
  {
    name: 'blender_live',
    description: 'Run bpy code inside the Blender window the user has open (needs the BlenderMCP add-on listening on port 9876). Use for inspecting or changing their scene. The user must approve it in Lumen.',
    inputSchema: obj({ code: str('Python (bpy) source'), description: str('One line telling the user what it does') }, ['code', 'description']),
    run: async (a) => {
      if (!api) throw new Error('Needs the desktop app.')
      const ok = await requestApproval({ title: 'Run code in your open Blender?', detail: String(a.description), code: String(a.code), requester: 'An AI agent' })
      if (!ok) throw new Error('The user declined to run this code.')
      const res = await api.blender.runLive(String(a.code))
      if (!res.ok) throw new Error(res.error)
      return res.result ?? { ok: true }
    },
  },
  {
    name: 'render_motion_graphic',
    description:
      'Render a HyperFrames motion graphic from a template and add it to the project (transparent). Templates and params — lower-third: { name, title, accent, accent2, align: "left"|"right", font }; title-card: { title, subtitle, eyebrow, accent, color, font: "sans"|"display"|"serif" }; kinetic: { text, style: "punch"|"stack", accent, color, font } (wrap words in *stars* to highlight); counter: { value, prefix, suffix, decimals, label, accent, accent2 }.',
    inputSchema: obj(
      {
        template: str('Template', { enum: ['lower-third', 'title-card', 'kinetic', 'counter'] }),
        params: { type: 'object', description: 'Template parameters (see description)', additionalProperties: true },
        duration_seconds: num('Clip length (defaults: lower third 5, others 4)', { minimum: 1, maximum: 30 }),
        place: PLACE,
        at_seconds: AT,
        wait_seconds: WAIT,
      },
      ['template', 'params'],
    ),
    run: (a) =>
      runJob(
        () =>
          renderMotion({
            template: a.template as 'lower-third',
            params: (a.params as Record<string, unknown>) ?? {},
            duration: typeof a.duration_seconds === 'number' ? a.duration_seconds : undefined,
            prompt: JSON.stringify(a.params),
          }),
        a,
      ),
  },
  {
    name: 'render_hyperframes_html',
    description:
      'Render your own HyperFrames composition (HTML + CSS + GSAP) to a transparent clip and add it to the project. Requirements: a <meta data-composition-id="ID" data-width data-height>, timed elements with class="clip" data-start data-duration data-track-index, and a paused GSAP timeline registered as window.__timelines["ID"]. Load GSAP from cdn.jsdelivr.net (Lumen swaps in a local copy). Keep html/body background transparent for overlays; size the page to the project (see get_project settings).',
    inputSchema: obj(
      {
        html: str('The complete HTML document'),
        name: str('Clip name'),
        duration_seconds: num('Length to render (default: the composition’s own duration)', { minimum: 0.1, maximum: 120 }),
        place: PLACE,
        at_seconds: AT,
        wait_seconds: WAIT,
      },
      ['html', 'name'],
    ),
    run: (a) => runJob(() => renderMotion({ template: 'custom', params: {}, html: String(a.html), name: String(a.name), duration: typeof a.duration_seconds === 'number' ? a.duration_seconds : undefined }), a),
  },
  {
    name: 'list_voices',
    description: 'ElevenLabs voices on the user’s account (needs ElevenLabs connected in Lumen).',
    inputSchema: obj({ search: str('Optional filter, e.g. "british" or "narrator"') }),
    run: async (a) => {
      if (!api) throw new Error('Needs the desktop app.')
      const voices = await api.elevenlabs.voices(typeof a.search === 'string' ? a.search : undefined)
      return voices.slice(0, 60).map((v) => ({ voice_id: v.id, name: v.name, category: v.category, labels: v.labels }))
    },
  },
  {
    name: 'generate_voiceover',
    description: 'Speak text with an ElevenLabs voice and add it to the project. It comes with a transcript, so add_captions-style edits and pause removal work on it. Places it on the timeline by default.',
    inputSchema: obj(
      {
        text: str('What to say'),
        voice_id: str('From list_voices (default: the first voice)'),
        model: str('Voice model', { enum: ['eleven_multilingual_v2', 'eleven_flash_v2_5'] }),
        place: PLACE,
        at_seconds: AT,
        wait_seconds: WAIT,
      },
      ['text'],
    ),
    run: async (a) => {
      const voices = useIntegrations.getState().voices
      const voice = voices.find((v) => v.id === a.voice_id) ?? voices[0]
      if (!voice && typeof a.voice_id !== 'string') throw new Error('No ElevenLabs voices — connect ElevenLabs in Lumen first.')
      return runJob(() => elevenSpeak({ text: String(a.text), voiceId: String(a.voice_id ?? voice!.id), voiceName: voice?.name, modelId: typeof a.model === 'string' ? a.model : undefined }), a)
    },
  },
  {
    name: 'generate_sound_effect',
    description: 'Generate a sound effect with ElevenLabs from a description (up to 30 s) and add it to the project.',
    inputSchema: obj({ prompt: str('Describe the sound'), duration_seconds: num('0.5–30 (default: automatic)', { minimum: 0.5, maximum: 30 }), loop: bool('Seamless loop'), place: PLACE, at_seconds: AT, wait_seconds: WAIT }, ['prompt']),
    run: (a) => runJob(() => elevenSfx({ prompt: String(a.prompt), durationSeconds: typeof a.duration_seconds === 'number' ? a.duration_seconds : undefined, loop: Boolean(a.loop) }), a),
  },
  {
    name: 'generate_music',
    description: 'Compose music with ElevenLabs from a prompt and add it to the project (paid ElevenLabs plans).',
    inputSchema: obj(
      { prompt: str('Genre, mood, instruments, structure'), length_seconds: num('3–600 (default 30)', { minimum: 3, maximum: 600 }), instrumental: bool('No vocals (default true)'), place: PLACE, at_seconds: AT, wait_seconds: WAIT },
      ['prompt'],
    ),
    run: (a) => runJob(() => elevenMusic({ prompt: String(a.prompt), lengthSeconds: typeof a.length_seconds === 'number' ? a.length_seconds : 30, instrumental: a.instrumental !== false }), a),
  },
  {
    name: 'transcribe_media',
    description:
      'Transcribe an audio or video asset and attach the timed transcript to it (powers captions, pause removal and ducking). Uses ElevenLabs or OpenAI when connected, otherwise Whisper on this computer.',
    inputSchema: obj(
      { asset_id: str('Media id from get_project'), language_code: str('Optional ISO language code, e.g. "en"'), provider: str('Optional: which service', { enum: ['elevenlabs', 'openai', 'local'] }) },
      ['asset_id'],
    ),
    run: async (a) => {
      const asset = getProject().assets[String(a.asset_id)]
      if (!canTranscribe(asset)) throw new Error('Only audio or video with sound can be transcribed.')
      const using = typeof a.provider === 'string' && transcribers().includes(a.provider as Transcriber) ? (a.provider as Transcriber) : undefined
      const transcript = await transcribeMedia(String(a.asset_id), { using, language: typeof a.language_code === 'string' ? a.language_code : undefined })
      return { phrases: transcript.length, transcript: transcript.slice(0, 60) }
    },
  },
  {
    name: 'find_pauses',
    description: 'Measure the long pauses in the speech on the timeline (from the audio itself, or transcripts). Returns the timeline spans remove_pauses would cut, in seconds (only where every speaker is quiet), and which clips were analysed.',
    inputSchema: obj({ clip_ids: { type: 'array', items: { type: 'string' }, description: 'Only these clips (default: every clip with speech)' }, min_gap_seconds: num('Shortest pause to report (default 0.6)', { minimum: 0.2, maximum: 5 }) }),
    run: async (a) => {
      const p = getProject()
      const fps = p.settings.fps
      const opts = { clipIds: Array.isArray(a.clip_ids) ? a.clip_ids.map(String) : undefined, minGap: typeof a.min_gap_seconds === 'number' ? a.min_gap_seconds : undefined }
      const reports = await findPauses(p, opts)
      const cuts = await silentCuts(p, reports, opts)
      const sec = (f: number) => Math.round((f / fps) * 100) / 100
      return {
        pauses: cuts.map(([s, e]) => [sec(s), sec(e)]),
        seconds: Math.round((cuts.reduce((t, [s, e]) => t + e - s, 0) / fps) * 10) / 10,
        clips: reports.map((r) => ({ clip_id: r.clip.id, clip: r.clip.name, measured_from: r.from })),
      }
    },
  },
  {
    name: 'remove_pauses',
    description: 'Cut long pauses out of the speech (keeping a little breath around each line). The whole timeline closes up around each cut, so captions, B-roll, effects and markers stay in sync; music beds play on through the joins. Only cuts where every speaker is quiet. One undo step.',
    inputSchema: obj({ clip_ids: { type: 'array', items: { type: 'string' }, description: 'Only these clips (default: every clip with speech)' }, min_gap_seconds: num('Shortest pause to cut (default 0.6)', { minimum: 0.2, maximum: 5 }) }),
    run: async (a) => {
      const r = await removePauses({ clipIds: Array.isArray(a.clip_ids) ? a.clip_ids.map(String) : undefined, minGap: typeof a.min_gap_seconds === 'number' ? a.min_gap_seconds : undefined })
      useUI.getState().markAiTouched(r.clips)
      return { pauses_removed: r.removed, seconds_saved: Math.round(r.seconds * 10) / 10 }
    },
  },
  {
    name: 'add_captions',
    description:
      'Caption all the speech on the timeline: transcribes any speech media that has no transcript yet, then lays timed captions on a Captions track (replacing earlier captions).',
    inputSchema: obj({
      max_words: num('Words per caption (default 6)', { minimum: 1, maximum: 16 }),
      size: num('Text size in project pixels (default: 4.5% of the frame)', { minimum: 12, maximum: 400 }),
      uppercase: bool('ALL CAPS captions'),
    }),
    run: async (a) => {
      const pending = untranscribed(getProject())
      if (pending.length && !(await ensureTranscripts(pending))) throw new Error('Transcription failed, so there’s nothing to caption yet.')
      const r = addCaptions({ maxWords: typeof a.max_words === 'number' ? a.max_words : undefined, size: typeof a.size === 'number' ? a.size : undefined, uppercase: Boolean(a.uppercase) })
      if (!r.added) throw new Error('No speech found on the timeline to caption.')
      return { captions_added: r.added, track_id: r.trackId }
    },
  },
  {
    name: 'duck_music',
    description: 'Lower music clips under speech with volume keyframes (short ramps, merged phrases). Finds the music and speech clips itself unless you pass ids.',
    inputSchema: obj({
      depth_db: num('How far to dip, in dB (default 10)', { minimum: 1, maximum: 40 }),
      music_clip_ids: { type: 'array', items: { type: 'string' } },
      voice_clip_ids: { type: 'array', items: { type: 'string' } },
    }),
    run: async (a) => {
      const r = await duckMusic({
        depth: typeof a.depth_db === 'number' ? a.depth_db : undefined,
        musicClipIds: Array.isArray(a.music_clip_ids) ? a.music_clip_ids.map(String) : undefined,
        voiceClipIds: Array.isArray(a.voice_clip_ids) ? a.voice_clip_ids.map(String) : undefined,
      })
      if (!r.ducked) throw new Error('Didn’t find both music and speech on the timeline.')
      return { music_clips_ducked: r.ducked, speech_regions: r.regions }
    },
  },
  {
    name: 'reframe',
    description: 'Change the canvas size (e.g. 1080x1920 for vertical) and reframe: footage that filled the old frame is scaled to fill the new one, titles are moved and resized to match.',
    inputSchema: obj({ width: num('Canvas width in pixels', { minimum: 16, maximum: 8192 }), height: num('Canvas height in pixels', { minimum: 16, maximum: 8192 }) }, ['width', 'height']),
    run: async (a) => reframe(Math.round(Number(a.width)), Math.round(Number(a.height))),
  },
  {
    name: 'generate_image',
    description: 'Generate an image with the user’s OpenAI (GPT Image) or Google (Gemini image) key and add it to the project.',
    inputSchema: obj(
      {
        prompt: str('What the image should show'),
        provider: str('Which service (default: whichever is connected)', { enum: ['openai', 'gemini'] }),
        model: str('Optional model id'),
        aspect: str('Shape (default: the project’s)', { enum: ['16:9', '9:16', '1:1'] }),
        place: PLACE,
        at_seconds: AT,
        wait_seconds: WAIT,
      },
      ['prompt'],
    ),
    run: async (a) => {
      const pick = await pickGenerator('image', a.provider, a.model)
      return runJob(() => generateImage({ provider: pick.provider, model: pick.model, prompt: String(a.prompt), aspect: (typeof a.aspect === 'string' ? a.aspect : projectAspect()) as '16:9' | '9:16' | '1:1' }), a)
    },
  },
  {
    name: 'generate_video',
    description: 'Generate a video clip with the user’s OpenAI or Google (Veo) key — whichever video models their key can use — and add it to the project. Takes a minute or more — returns the job; it lands on the timeline when done.',
    inputSchema: obj(
      {
        prompt: str('Describe the shot: subject, action, camera, light'),
        provider: str('Which service (default: whichever is connected)', { enum: ['openai', 'gemini'] }),
        model: str('Optional model id'),
        aspect: str('Shape (default: the project’s)', { enum: ['16:9', '9:16'] }),
        seconds: num('Length in seconds (each model allows a few lengths, e.g. Veo: 4, 6 or 8)', { minimum: 1, maximum: 20 }),
        place: PLACE,
        at_seconds: AT,
        wait_seconds: WAIT,
      },
      ['prompt'],
    ),
    run: async (a) => {
      const pick = await pickGenerator('video', a.provider, a.model)
      const aspect = typeof a.aspect === 'string' ? a.aspect : projectAspect() === '9:16' ? '9:16' : '16:9'
      return runJob(() => generateVideo({ provider: pick.provider, model: pick.model, prompt: String(a.prompt), aspect: aspect as '16:9' | '9:16', seconds: typeof a.seconds === 'number' ? a.seconds : 8 }), { wait_seconds: 20, ...a })
    },
  },
  {
    name: 'add_sound_effect',
    description: `Add one of Lumen’s built-in sound effects at a time on the timeline. Available: ${SFX.map((s) => `${s.id} (${s.description})`).join(', ')}.`,
    inputSchema: obj({ sfx_id: str('Which effect', { enum: SFX.map((s) => s.id) }), at_seconds: AT }, ['sfx_id']),
    run: async (a) => {
      const assetId = await sfxAsset(String(a.sfx_id))
      const at = typeof a.at_seconds === 'number' ? Math.round(a.at_seconds * getProject().settings.fps) : usePlayback.getState().frame
      const clip = placeAsset(assetId, at, { source: 'ai' })
      return { asset_id: assetId, clip_id: clip }
    },
  },
  {
    name: 'import_media_file',
    description: 'Import video, audio or image files from this computer into the project by path (folders import every media file inside). Optionally place them on the timeline one after another.',
    inputSchema: obj({ paths: { type: 'array', items: { type: 'string' }, description: 'Absolute file or folder paths' }, place: bool('Also put them on the timeline at the playhead (default false)'), at_seconds: AT }, ['paths']),
    run: async (a) => {
      if (!desktop) throw new Error('Needs the desktop app.')
      const paths = Array.isArray(a.paths) ? a.paths.map(String) : []
      const assets = await importMediaFiles(await desktop.files.register(paths))
      if (!assets.length) throw new Error('No importable media found at those paths.')
      let at = typeof a.at_seconds === 'number' ? Math.round(a.at_seconds * getProject().settings.fps) : usePlayback.getState().frame
      const clips: string[] = []
      if (a.place) {
        for (const asset of assets) {
          const clip = placeAsset(asset.id, at, { source: 'ai' })
          if (clip) {
            clips.push(clip)
            at = clipEnd(getProject().clips[clip])
          }
        }
      }
      return { asset_ids: assets.map((x) => x.id), ...(clips.length ? { clip_ids: clips } : {}) }
    },
  },
  {
    name: 'get_job',
    description: 'Status of a render or generation job. Waits up to wait_seconds for it to finish.',
    inputSchema: obj({ job_id: str('Job id'), wait_seconds: WAIT }, ['job_id']),
    run: async (a) => jobReport(await waitForJob(String(a.job_id), Math.min(600, Number(a.wait_seconds ?? 30)))),
  },
  {
    name: 'import_media_url',
    description: 'Download an image, video or audio file from a URL (e.g. a generation result) into the project’s media, optionally placing it.',
    inputSchema: obj({ url: str('https:// URL of the file'), name: str('Media name'), place: bool('Also put it on the timeline at the playhead (default false)'), at_seconds: AT }, ['url']),
    run: async (a) => {
      const assetId = await importLink(String(a.url), typeof a.name === 'string' ? a.name : undefined, { integration: 'agent', tool: 'import_media_url' })
      const at = typeof a.at_seconds === 'number' ? Math.round(a.at_seconds * getProject().settings.fps) : usePlayback.getState().frame
      const clip = a.place ? placeAsset(assetId, at, { source: 'ai' }) : null
      return { asset_id: assetId, ...(clip ? { clip_id: clip } : {}) }
    },
  },
]

function editorTools(): AgentTool[] {
  return toolDefinitions().map((def) => {
    const name = (Object.keys(commands) as CommandName[]).find((n) => n.replace('.', '_') === def.name)!
    return {
      name: def.name,
      description: def.description,
      inputSchema: def.inputSchema as Record<string, unknown>,
      run: async (args) => {
        const res = dispatch(name, args as never, { source: 'ai' })
        if (!res.ok) throw new Error(res.error)
        return { ok: true, result: res.result ?? null }
      },
    }
  })
}

let cache: AgentTool[] | null = null
export function agentTools(): AgentTool[] {
  cache ??= [...INTEGRATION_TOOLS, ...VISION_TOOLS, ...INSPECT_TOOLS, ...CONTROL_TOOLS, ...editorTools()]
  return cache
}

export async function runAgentTool(name: string, args: Record<string, unknown>): Promise<BridgeToolResult> {
  const tool = agentTools().find((t) => t.name === name)
  if (!tool) return { content: [{ type: 'text', text: `Unknown tool: ${name}. Call get_project to start; the tool list names every tool.` }], isError: true }
  try {
    const out = await tool.run(args ?? {})
    const result = out instanceof WithImages ? out.json : out
    const structured = result && typeof result === 'object' && !Array.isArray(result) ? (result as Record<string, unknown>) : { result }
    const content: BridgeToolResult['content'] = [{ type: 'text', text: JSON.stringify(result, null, 2) }]
    if (out instanceof WithImages && out.images.length) {
      content.push(...out.images.map((img) => ({ type: 'image' as const, data: img.data, mimeType: img.mimeType })))
      emitToolImages(name, out.images)
    }
    return { content, structuredContent: structured }
  } catch (err) {
    return { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true }
  }
}
