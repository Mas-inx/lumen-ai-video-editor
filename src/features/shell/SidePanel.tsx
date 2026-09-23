import { SlidersHorizontal } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { AiSparkle } from '@/components/brand'
import { Segmented } from '@/components/ui/segmented'
import { useUI, type RightTab } from '@/editor/ui-store'
import { CopilotPanel } from '@/features/copilot/CopilotPanel'
import { Inspector } from '@/features/inspector/Inspector'

export function SidePanel() {
  const tab = useUI((s) => s.rightTab)
  const setTab = useUI((s) => s.setRightTab)
  return (
    <div className="panel flex h-full flex-col overflow-hidden">
      <div className="flex h-11 shrink-0 items-center border-b border-line px-2.5">
        <Segmented<RightTab>
          value={tab}
          onChange={setTab}
          stretch
          options={[
            { value: 'inspector', label: 'Inspector', icon: <SlidersHorizontal /> },
            { value: 'copilot', label: 'Copilot', icon: <AiSparkle className="!size-3.5" /> },
          ]}
        />
      </div>
      <div className="relative min-h-0 flex-1">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.div
            key={tab}
            initial={{ opacity: 0, x: tab === 'copilot' ? 12 : -12 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: tab === 'copilot' ? -12 : 12 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            className="absolute inset-0"
          >
            {tab === 'inspector' ? <Inspector /> : <CopilotPanel />}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  )
}
