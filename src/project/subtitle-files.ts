/**
 * Subtitle files on disk: bringing an .srt / .vtt in as captions, and saving the
 * timeline's captions as one — on its own, or beside an exported video.
 */
import { toast } from 'sonner'
import { getProject } from '@/editor/store'
import { formatCues, importSubtitles, timelineCues, type SubtitleFormat } from '@/editor/subtitles'
import { desktop } from '@/lib/platform'

export const SUBTITLE_FORMATS: Record<SubtitleFormat, { label: string; filter: string }> = {
  srt: { label: 'SRT', filter: 'SubRip subtitles' },
  vtt: { label: 'WebVTT', filter: 'WebVTT subtitles' },
}

/** Reads a subtitle file the user picks and lays it on the timeline. */
export function pickSubtitles() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.srt,.vtt,text/vtt'
  input.multiple = true
  input.onchange = () => {
    for (const file of input.files ?? []) void loadSubtitleFile(file)
  }
  input.click()
}

export async function loadSubtitleFile(file: File) {
  try {
    const res = importSubtitles(await file.text(), { name: file.name.replace(/\.[^.]+$/, '') })
    toast.success(`${res.added} caption${res.added === 1 ? '' : 's'} from ${file.name}`)
    return res
  } catch (err) {
    toast.error(`Couldn’t read ${file.name}`, { description: err instanceof Error ? err.message : String(err) })
    return null
  }
}

/**
 * Saves the timeline's captions as an .srt or .vtt file where the user chooses
 * (a download outside the desktop app). Null if there are none or they cancel.
 */
export async function saveSubtitles(format: SubtitleFormat, name = getProject().name): Promise<{ path: string; cues: number } | null> {
  const cues = timelineCues(getProject())
  if (!cues.length) {
    toast('No captions to export', { description: 'Add captions (or import a subtitle file) first.' })
    return null
  }
  const text = formatCues(cues, format)
  if (!desktop) {
    const url = URL.createObjectURL(new Blob([text], { type: format === 'vtt' ? 'text/vtt' : 'application/x-subrip' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `${name}.${format}`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 5000)
    return { path: a.download, cues: cues.length }
  }
  const handle = await desktop.export.begin({ defaultName: name, extension: format, filterName: SUBTITLE_FORMATS[format].filter })
  if (!handle) return null
  try {
    await desktop.export.write(handle.id, 0, new TextEncoder().encode(text))
    const res = await desktop.export.finish(handle.id)
    toast.success(`Saved ${cues.length} caption${cues.length === 1 ? '' : 's'}`, { description: res.path, action: { label: 'Show', onClick: () => void desktop?.files.reveal(res.path) } })
    return { path: res.path, cues: cues.length }
  } catch (err) {
    await desktop.export.abort(handle.id).catch(() => {})
    throw err
  }
}
