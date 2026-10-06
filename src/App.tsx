import { LoaderCircle } from 'lucide-react'
import { useEffect } from 'react'
import { Group, Panel, useDefaultLayout } from 'react-resizable-panels'
import { Toaster } from 'sonner'
import { startTimelineNav } from '@/editor/timeline-nav'
import { startMediaEngine } from '@/engine/wiring'
import { HomeScreen } from '@/features/home/HomeScreen'
import { startSession, useSession } from '@/project/session'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AssetsPanel } from '@/features/assets/AssetsPanel'
import { CommandPalette } from '@/features/command/CommandPalette'
import { ExportDialog } from '@/features/export/ExportDialog'
import { RenderQueueDialog } from '@/features/export/RenderQueue'
import { MulticamDialog } from '@/features/multicam/MulticamDialog'
import { AboutDialog } from '@/features/shell/AboutDialog'
import { GraphicsDialog } from '@/features/shell/GraphicsDialog'
import { AgentApprovals } from '@/features/integrations/AgentApprovals'
import { IntegrationsHub } from '@/features/integrations/IntegrationsHub'
import { PreviewPanel } from '@/features/preview/PreviewPanel'
import { ResizeHandle } from '@/features/shell/ResizeHandle'
import { ShortcutsDialog } from '@/features/shell/ShortcutsDialog'
import { VersionHistoryDialog } from '@/features/shell/VersionHistoryDialog'
import { SidePanel } from '@/features/shell/SidePanel'
import { TitleBar } from '@/features/shell/TitleBar'
import { useGlobalShortcuts } from '@/features/shell/useGlobalShortcuts'
import { PasteAttributesDialog } from '@/features/timeline/PasteAttributesDialog'
import { RenameTimelineDialog } from '@/features/timeline/TimelineSwitcher'
import { Timeline } from '@/features/timeline/Timeline'
import { startAi } from '@/integrations/ai'
import { startBridgeClient } from '@/integrations/bridge'
import { startIntegrations } from '@/integrations/store'
import { startIngestClient } from '@/project/ingest'
import { startUpdates } from '@/lib/updates'

export function App() {
  useGlobalShortcuts()
  useEffect(() => {
    void startSession()
    startMediaEngine()
    startTimelineNav()
    // Blender, HyperFrames and MCP live in the desktop app's main process.
    startIntegrations()
    startBridgeClient()
    startIngestClient()
    startAi()
    startUpdates()
  }, [])
  const home = useSession((s) => s.home)

  return (
    <TooltipProvider delayDuration={450} skipDelayDuration={250}>
      <div className="relative flex h-screen flex-col overflow-hidden bg-canvas text-fg">
        {/* Ambient light behind the floating panels */}
        <div className="pointer-events-none absolute -top-40 left-1/2 h-80 w-[70vw] -translate-x-1/2 rounded-full bg-accent/[0.05] blur-[90px]" />

        <TitleBar />

        {home ? <HomeScreen /> : <Editor />}

        <CommandPalette />
        <ExportDialog />
        <ShortcutsDialog />
        <AboutDialog />
        <GraphicsDialog />
        <PasteAttributesDialog />
        <VersionHistoryDialog />
        <RenameTimelineDialog />
        <RenderQueueDialog />
        <MulticamDialog />
        <IntegrationsHub />
        <AgentApprovals />
        <Toaster
          position="bottom-center"
          offset={20}
          gap={8}
          icons={{ loading: <LoaderCircle className="size-4 animate-spin" /> }}
          toastOptions={{
            unstyled: true,
            classNames: {
              toast: 'popover flex w-[360px] items-center gap-3 rounded-xl px-3.5 py-3 text-sm text-fg',
              title: 'font-medium text-fg',
              description: 'text-xs text-fg-3 whitespace-pre-line',
              actionButton: 'ml-auto shrink-0 rounded-md bg-white/[0.08] px-2 py-1 text-xs font-medium text-fg hover:bg-white/[0.14]',
              icon: 'relative grid size-5 shrink-0 place-items-center text-accent-2',
            },
          }}
        />
      </div>
    </TooltipProvider>
  )
}

function Editor() {
  const vertical = useDefaultLayout({ id: 'lumen-layout-v', storage: localStorage })
  const horizontal = useDefaultLayout({ id: 'lumen-layout-h', storage: localStorage })
  return (
    <main className="relative flex min-h-0 flex-1 px-2 pb-2">
      <Group orientation="vertical" id="lumen-layout-v" defaultLayout={vertical.defaultLayout} onLayoutChanged={vertical.onLayoutChanged}>
        <Panel id="stage" defaultSize="58%" minSize="260px">
          <Group orientation="horizontal" id="lumen-layout-h" defaultLayout={horizontal.defaultLayout} onLayoutChanged={horizontal.onLayoutChanged}>
            <Panel id="assets" defaultSize="24%" minSize="300px" maxSize="40%">
              <AssetsPanel />
            </Panel>
            <ResizeHandle />
            <Panel id="viewer" minSize="380px">
              <PreviewPanel />
            </Panel>
            <ResizeHandle />
            <Panel id="side" defaultSize="25%" minSize="300px" maxSize="38%">
              <SidePanel />
            </Panel>
          </Group>
        </Panel>
        <ResizeHandle vertical />
        <Panel id="timeline" defaultSize="42%" minSize="200px">
          <Timeline />
        </Panel>
      </Group>
    </main>
  )
}

