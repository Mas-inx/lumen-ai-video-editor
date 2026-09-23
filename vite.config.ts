import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import tailwindcss from '@tailwindcss/vite'
import electron from 'vite-plugin-electron/simple'

/**
 * Production-only CSP. Dev needs inline scripts for React Fast Refresh,
 * so the policy is injected at build time instead of living in index.html.
 */
function contentSecurityPolicy(): Plugin {
  const policy = [
    "default-src 'self'",
    // WebAssembly: RNNoise (noise reduction) and ONNX Runtime (on-device Whisper)
    "script-src 'self' 'wasm-unsafe-eval'",
    "worker-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'",
    // lumen-media: imported media, renders, downloads and on-device models served by the main process
    "img-src 'self' data: blob: lumen-media: https:",
    "media-src 'self' data: blob: lumen-media:",
    "font-src 'self' data:",
    "connect-src 'self' data: blob: lumen-media:",
  ].join('; ')
  return {
    name: 'lumen:csp',
    apply: 'build',
    transformIndexHtml: () => [
      { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: policy }, injectTo: 'head-prepend' },
    ],
  }
}

// `vite`            → Electron app with HMR
// `vite --mode web` → the same UI in a plain browser tab (fast iteration, future web build)
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }

export default defineConfig(({ mode }) => {
  const web = mode === 'web'
  return {
    base: './',
    define: { __APP_VERSION__: JSON.stringify(pkg.version) },
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
        '@shared': fileURLToPath(new URL('./shared', import.meta.url)),
      },
    },
    plugins: [
      react(),
      babel({ presets: [reactCompilerPreset()] }),
      tailwindcss(),
      contentSecurityPolicy(),
      !web &&
        electron({
          main: {
            entry: 'electron/main.ts',
            // The MCP and AI SDKs load from node_modules at runtime rather than being bundled.
            vite: { build: { rolldownOptions: { external: [/^@modelcontextprotocol\/sdk/, /^ai$/, /^@ai-sdk\//, /^@openrouter\/ai-sdk-provider/] } } },
          },
          preload: { input: 'electron/preload.ts' },
        }),
    ],
    server: { port: 5173, strictPort: true },
    // The on-device speech model runs in a module worker.
    worker: { format: 'es' },
    // Pre-bundle lazily loaded engines so the dev server never reloads mid-session to optimize them.
    optimizeDeps: { include: ['mediabunny', 'gifenc', '@huggingface/transformers', '@shiguredo/rnnoise-wasm'] },
    // Desktop app loading from disk — a single ~2 MB chunk (three.js included) is fine.
    build: { chunkSizeWarningLimit: 2400 },
    clearScreen: false,
  }
})
