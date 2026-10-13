import { MousePointerClick, Sparkles, X, ZoomIn } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button, IconButton } from '@/components/ui/button'
import { Row, Section } from '@/components/ui/section'
import { Slider } from '@/components/ui/slider'
import { clipClicks, highlightClicks, zoomOnClicks } from '@/capture/click-actions'
import { useEditor } from '@/editor/store'
import type { Clip } from '@/editor/types'

/** A screen recording's clicks: zoom in on them, or draw a pulse on each. Shown for clips whose recording kept click data. */
export function ClicksSection({ clip }: { clip: Clip }) {
  const cursor = useEditor((s) => (clip.assetId ? s.project.assets[clip.assetId]?.cursor : undefined))
  const [zoom, setZoom] = useState(2)
  if (!cursor) return null
  const clicks = clipClicks(clip).filter((c) => c.click.button === 'left').length
  const zoomed = (clip.keyframes.scale?.length ?? 0) > 1
  const run = (what: string, fn: () => void) => {
    try {
      fn()
    } catch (err) {
      toast.error(what, { description: err instanceof Error ? err.message : String(err) })
    }
  }
  return (
    <Section title="Clicks" icon={<MousePointerClick />} defaultOpen>
      <div className="space-y-2">
        <p className="text-2xs leading-relaxed text-fg-4">
          {clicks ? `This recording kept ${clicks} click${clicks === 1 ? '' : 's'} inside this clip. Zoom in on them, or draw a pulse where each landed.` : 'This recording kept its clicks, but none fall inside this clip.'}
        </p>
        <Row label="Zoom">
          <Slider value={zoom} min={1.2} max={4} step={0.1} onChange={setZoom} disabled={!clicks} />
          <span className="w-9 shrink-0 text-right text-xs font-medium text-fg-2 tabular">{zoom.toFixed(1)}×</span>
        </Row>
        <div className="flex items-center gap-1.5">
          <Button size="xs" variant="secondary" disabled={!clicks} className="flex-1 justify-center" onClick={() => run('Couldn’t zoom on the clicks', () => zoomOnClicks(clip.id, { zoom }))}>
            <ZoomIn /> {zoomed ? 'Zoom again' : 'Zoom on clicks'}
          </Button>
          {zoomed && (
            <IconButton size="xs" label="Remove the zooms" onClick={() => run('Couldn’t remove the zooms', () => zoomOnClicks(clip.id, { clear: true }))}>
              <X />
            </IconButton>
          )}
        </div>
        <Button size="xs" variant="secondary" disabled={!clicks} className="w-full justify-center" onClick={() => run('Couldn’t highlight the clicks', () => highlightClicks(clip.id))}>
          <Sparkles /> Highlight clicks
        </Button>
      </div>
    </Section>
  )
}
