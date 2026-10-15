import { Volume1, Volume2, VolumeX } from 'lucide-react'
import { IconButton } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Slider } from '@/components/ui/slider'
import { playback, usePlayback } from '@/editor/playback'
import { cn } from '@/lib/cn'

/**
 * How loud Lumen plays while you edit. It isn't the mix: clip, track and master
 * levels, the meter and every export stay as they are.
 */
export function PreviewVolume() {
  const volume = usePlayback((s) => s.volume)
  const muted = usePlayback((s) => s.muted)
  const silent = muted || volume === 0
  const pct = Math.round(volume * 100)
  const Icon = silent ? VolumeX : volume < 0.5 ? Volume1 : Volume2
  const icon = <Icon className={cn(silent && 'text-warn')} />

  return (
    <Popover>
      <PopoverTrigger asChild>
        <IconButton
          label={muted ? 'Preview muted' : `Preview volume ${pct}%`}
          // Scrolling over the speaker nudges the level, as in most players.
          onWheel={(e) => e.deltaY && playback.setVolume(volume + (e.deltaY < 0 ? 0.05 : -0.05))}
        >
          {icon}
        </IconButton>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        className="w-64"
        // The slider takes focus, so arrow keys change the level at once (and Mute's tip doesn't cover the title).
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          ;(e.currentTarget as HTMLElement | null)?.querySelector<HTMLElement>('[role="slider"]')?.focus()
        }}
      >
        <div className="flex items-baseline justify-between">
          <span className="text-xs font-semibold text-fg">Preview volume</span>
          <span className="font-mono text-xs text-fg-3 tabular">{muted ? 'Muted' : `${pct}%`}</span>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <IconButton label={silent ? 'Unmute' : 'Mute'} shortcut="shift+m" onClick={() => playback.toggleMute()}>
            {icon}
          </IconButton>
          <Slider
            value={pct}
            min={0}
            max={100}
            defaultValue={100}
            onChange={(v) => playback.setVolume(v / 100)}
            aria-label="Preview volume"
            // Muted keeps its level, greyed: moving the slider unmutes.
            className={cn('mr-1', muted && 'opacity-45')}
          />
        </div>
        <p className="mt-2 text-2xs leading-relaxed text-fg-4">
          Only how loud Lumen plays while you edit, here and in the libraries. Your mix and exports stay as they are. Double-click the slider for 100%.
        </p>
      </PopoverContent>
    </Popover>
  )
}
