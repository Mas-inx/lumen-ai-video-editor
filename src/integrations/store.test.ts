import { describe, expect, it, vi } from 'vitest'
import type { Job } from '@shared/integrations'

// The desktop bridge, standing in: a render that fails at once. Its events reach
// the editor before the reply to the request that started it.
let emit: (job: Job) => void = () => {}
const started: Job = { id: 'job-1', integration: 'hyperframes', title: 'Lower third', status: 'running', progress: -1, startedAt: 0 }
vi.stubGlobal('window', {
  lumen: {
    integrations: {
      onJob: (listener: (job: Job) => void) => {
        emit = listener
      },
      onMcp: () => {},
      jobs: { list: async () => [] },
      mcp: { list: async () => [] },
      blender: { detect: async () => null },
      elevenlabs: { state: async () => ({ configured: false }) },
      motion: {
        render: async () => {
          emit(started)
          emit({ ...started, status: 'error', error: 'Cannot find module' })
          return started
        },
      },
    },
  },
})

const { renderMotion, startIntegrations, useIntegrations } = await import('./store')

describe('jobs', () => {
  it('stay finished when the reply that started them arrives after their last event', async () => {
    startIntegrations()
    await renderMotion({ template: 'lower-third', params: {}, width: 1920, height: 1080, fps: 30 })
    expect(useIntegrations.getState().jobs['job-1']).toMatchObject({ status: 'error', error: 'Cannot find module' })
  })
})
