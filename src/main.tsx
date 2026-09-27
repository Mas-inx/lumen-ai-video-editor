import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles/index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// Handle for poking at the editor from the console / test scripts (dev, or test launches of a build).
if (import.meta.env.DEV || window.lumen?.testMode) {
  void Promise.all([
    import('@/editor/store'),
    import('@/editor/ui-store'),
    import('@/editor/playback'),
    import('@/features/copilot/store'),
    import('@/integrations/ai'),
    import('@/integrations/store'),
    import('@/project/session'),
    import('@/project/media-import'),
    import('@/engine/export'),
    import('@/editor/smart'),
    import('@/project/transcribe'),
    import('@/engine/audio-engine'),
    import('@/integrations/agent-tools'),
    import('@/engine/media'),
    import('@/project/proxies'),
    import('@/editor/sequences'),
    import('@/editor/timeline-nav'),
    import('@/project/analysis-actions'),
    import('@/engine/render-queue'),
    import('@/project/subtitle-files'),
    import('@/engine/compositor'),
    import('mediabunny'),
  ]).then(([store, ui, pb, copilot, ai, integrations, session, media, exporter, smart, transcribe, audio, tools, engineMedia, proxies, sequences, nav, analysis, queue, subtitles, compositor, mediabunny]) => {
    Object.assign(window, {
      __lumen: {
        editor: store.useEditor,
        dispatch: store.dispatch,
        ui: ui.useUI,
        playback: pb.playback,
        usePlayback: pb.usePlayback,
        copilot,
        ai,
        integrations,
        session,
        media,
        exporter,
        smart,
        transcribe,
        audio,
        tools,
        engineMedia,
        proxies,
        sequences,
        nav,
        analysis,
        queue,
        subtitles,
        compositor,
        mediabunny,
      },
    })
  })
}
