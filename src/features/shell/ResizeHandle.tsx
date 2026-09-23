import { Separator } from 'react-resizable-panels'
import { cn } from '@/lib/cn'

/** The gap between floating panels doubles as the resize handle. */
export function ResizeHandle({ vertical }: { vertical?: boolean }) {
  return (
    <Separator
      className={cn(
        'group/handle relative flex shrink-0 items-center justify-center outline-none',
        vertical ? 'h-2 w-full' : 'h-full w-2',
      )}
    >
      <span
        className={cn(
          'rounded-full bg-accent opacity-0 transition-[opacity,transform] duration-200',
          'group-data-[separator=hover]/handle:opacity-60 group-data-[separator=active]/handle:opacity-100 group-data-[separator=focus]/handle:opacity-100',
          vertical ? 'h-[3px] w-10 group-data-[separator=active]/handle:w-16' : 'h-10 w-[3px] group-data-[separator=active]/handle:h-16',
        )}
      />
    </Separator>
  )
}
