/**
 * Frame ingest for agents: start Lumen's receiver and hand its address to the
 * app that will send frames (GS Cinematic Studio's render_export takes it as
 * lumen_url and lumen_token), then find the clips that arrived.
 */
import { INGEST_FORMATS, INGEST_QUALITIES, type IngestClip, type IngestQuality } from '@shared/ingest'
import { cueText } from '@/editor/cues'
import { getProject } from '@/editor/store'
import { setIngestEnabled, setIngestOptions, useIngest } from '@/project/ingest'
import { desktop } from '@/lib/platform'
import { int, obj, oneOf, text, type AgentTool } from './kit'

const QUALITY_IDS = INGEST_QUALITIES.map((q) => q.id)

function describe(clip: IngestClip) {
  const asset = clip.assetId ? getProject().assets[clip.assetId] : undefined
  const inLibrary = Boolean(asset)
  const { source, ...meta } = clip.meta
  return {
    clip_id: clip.id,
    name: clip.name,
    status: clip.status,
    received: clip.received,
    frames: clip.frames || clip.received,
    size: `${clip.width}x${clip.height}`,
    fps: clip.fps,
    quality: clip.quality,
    ...(source ? { source } : {}),
    // What the sender said about it; a list in there (its cue sheet) shows as a count.
    ...(Object.keys(meta).length ? { meta } : {}),
    ...(clip.status === 'done' ? { asset_id: clip.assetId, in_this_project: inLibrary, path: clip.path, duration_seconds: clip.durationSeconds, codec: clip.codec, bytes: clip.bytes } : {}),
    // The cue sheet as it is kept on the media item, in seconds from the clip's first frame.
    ...(asset?.cues?.length ? { cues: asset.cues.slice(0, 200).map((c) => ({ at: c.at, kind: c.kind, what: cueText(c), ...(c.who ? { who: c.who } : {}), ...(c.seconds ? { seconds: c.seconds } : {}) })) } : {}),
    ...(clip.error ? { error: clip.error } : {}),
  }
}

export const INGEST_TOOLS: AgentTool[] = [
  {
    name: 'ingest_start',
    description:
      'Start Lumen’s frame-ingest receiver and get its address: { url, token, formats }. Another app on this computer then sends a shot’s frames losslessly and Lumen encodes them once into a master clip in the media library (not on the timeline). For GS Cinematic Studio, pass url and token to its render_export as lumen_url and lumen_token, then use ingest_status to find the clip and place_asset to put it on the timeline. quality sets how masters are compressed when the sender doesn’t say: master (visually lossless, the default), lossless (every pixel, about 4× larger) or compact.',
    inputSchema: obj({ quality: oneOf('How masters are compressed by default', QUALITY_IDS) }),
    run: async (a) => {
      if (!desktop) throw new Error('Frame ingest needs the desktop app.')
      const quality = QUALITY_IDS.find((q) => q === text(a, 'quality')) as IngestQuality | undefined
      if (quality) await setIngestOptions({ quality })
      // Running already (the user's switch) stays as it is; otherwise it starts for this session.
      const state = useIngest.getState().state?.running ? useIngest.getState().state! : await setIngestEnabled(true, false)
      if (!state.url) throw new Error(state.error ?? 'Couldn’t start the receiver.')
      return {
        url: state.url,
        token: state.token,
        formats: INGEST_FORMATS,
        quality: state.quality,
        folder: state.folder,
        how: 'POST {url}/clips, PUT {url}/clips/{clip_id}/frames/{index} for each frame in order, POST {url}/clips/{clip_id}/finish, then GET {url}/clips/{clip_id} until status is done. Every request carries Authorization: Bearer {token}.',
      }
    },
  },
  {
    name: 'ingest_status',
    description:
      'The clips Lumen’s frame-ingest receiver has been sent, newest first, with status (receiving, assembling, done, error), how many frames arrived, what the sender said about each (meta), and for finished clips the asset_id in the media library and its cues: what happens in the clip and when (lines said, cuts, footsteps), since it has no sound of its own. Use it to find what arrived, then place_asset; get_clip then gives the cues at timeline seconds.',
    inputSchema: obj({ limit: int('How many clips to list (default 10)', { minimum: 1, maximum: 40 }) }),
    run: async (a) => {
      if (!desktop) throw new Error('Frame ingest needs the desktop app.')
      const state = await desktop.ingest.state()
      useIngest.setState({ state })
      const limit = typeof a.limit === 'number' ? Math.max(1, Math.min(40, Math.floor(a.limit))) : 10
      return { running: state.running, ...(state.url ? { url: state.url } : {}), clips: state.clips.slice(0, limit).map(describe) }
    },
  },
]
