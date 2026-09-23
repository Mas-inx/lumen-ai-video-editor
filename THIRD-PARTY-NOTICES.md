# Third-party notices

Lumen is released under the [MIT license](LICENSE). It is built on, and its installer includes, the open-source work below. Each package keeps its own license; the full texts ship inside the packages in `node_modules` and, for the installer, in `resources/app.asar`.

## Packages

| Package | Version | License |
| --- | --- | --- |
| [@ai-sdk/anthropic](https://ai-sdk.dev/docs) | 4.0.60 | Apache-2.0 |
| [@ai-sdk/google](https://ai-sdk.dev/docs) | 4.0.77 | Apache-2.0 |
| [@ai-sdk/openai](https://ai-sdk.dev/docs) | 4.0.72 | Apache-2.0 |
| [@ai-sdk/openai-compatible](https://ai-sdk.dev/docs) | 3.0.53 | Apache-2.0 |
| [@fontsource-variable/bricolage-grotesque](https://fontsource.org/fonts/bricolage-grotesque) | 5.3.0 | OFL-1.1 |
| [@fontsource-variable/caveat](https://fontsource.org/fonts/caveat) | 5.3.0 | OFL-1.1 |
| [@fontsource-variable/geist](https://fontsource.org/fonts/geist) | 5.3.0 | OFL-1.1 |
| [@fontsource-variable/geist-mono](https://fontsource.org/fonts/geist-mono) | 5.3.0 | OFL-1.1 |
| [@fontsource/bricolage-grotesque](https://fontsource.org/fonts/bricolage-grotesque) | 5.3.0 | OFL-1.1 |
| [@fontsource/geist](https://fontsource.org/fonts/geist) | 5.3.0 | OFL-1.1 |
| [@fontsource/instrument-serif](https://fontsource.org/fonts/instrument-serif) | 5.3.0 | OFL-1.1 |
| [@huggingface/transformers](https://github.com/huggingface/transformers.js#readme) | 4.3.0 | Apache-2.0 |
| [@modelcontextprotocol/sdk](https://modelcontextprotocol.io) | 1.30.0 | MIT |
| [@openrouter/ai-sdk-provider](https://github.com/OpenRouterTeam/ai-sdk-provider) | 3.1.0 | Apache-2.0 |
| [@shiguredo/rnnoise-wasm](https://github.com/shiguredo/rnnoise-wasm#readme) | 2025.1.5 | Apache-2.0 |
| [ai](https://ai-sdk.dev/docs) | 7.0.111 | Apache-2.0 |
| [clsx](lukeed/clsx) | 2.1.1 | MIT |
| [cmdk](https://github.com/pacocoursey/cmdk#readme) | 1.1.1 | MIT |
| [electron](https://github.com/electron/electron) | 44.4.3 | MIT |
| [gifenc](https://github.com/mattdesl/gifenc) | 1.0.3 | MIT |
| [gsap](https://gsap.com) | 3.15.0 | GSAP Standard License |
| [immer](https://github.com/immerjs/immer#readme) | 11.1.18 | MIT |
| [lucide-react](https://lucide.dev) | 1.47.0 | ISC |
| [mediabunny](https://mediabunny.dev/) | 1.59.0 | MPL-2.0 |
| [motion](https://github.com/motiondivision/motion) | 13.4.1 | MIT |
| [nanoid](ai/nanoid) | 6.0.1 | MIT |
| [opentype.js](https://github.com/opentypejs/opentype.js) | 2.0.0 | MIT |
| [radix-ui](https://radix-ui.com/primitives) | 1.6.7 | MIT |
| [react](https://react.dev/) | 19.3.0 | MIT |
| [react-dom](https://react.dev/) | 19.3.0 | MIT |
| [react-resizable-panels](https://react-resizable-panels.vercel.app/) | 4.13.2 | MIT |
| [sonner](https://sonner.emilkowal.ski/) | 2.0.8 | MIT |
| [tailwind-merge](https://github.com/dcastil/tailwind-merge) | 3.7.0 | MIT |
| [tailwindcss](https://tailwindcss.com) | 4.3.3 | MIT |
| [three](https://threejs.org/) | 0.186.0 | MIT |
| [zod](https://zod.dev) | 4.6.5 | MIT |
| [zustand](https://github.com/pmndrs/zustand) | 5.0.15 | MIT |
| [onnxruntime-web](https://github.com/microsoft/onnxruntime) | 1.31 | MIT |
| [@hyperframes/core](https://github.com/heygen-com/hyperframes) | 0.8.61 | Apache-2.0 |

## Also included or used

- **Electron and Chromium** — the installer includes Electron (MIT) and Chromium, whose licenses are listed in `LICENSES.chromium.html` next to `Lumen.exe`. That includes FFmpeg as built for Chromium (LGPL 2.1).
- **RNNoise** (BSD-3-Clause) — noise reduction, compiled to WebAssembly by `@shiguredo/rnnoise-wasm`.
- **Whisper** — the speech model (`onnx-community/whisper-base`, a conversion of OpenAI's Whisper, MIT) is downloaded from Hugging Face the first time you transcribe on your device. It isn't part of the installer.
- **Fonts** — Geist, Geist Mono, Bricolage Grotesque, Instrument Serif and Caveat, under the SIL Open Font License 1.1, via Fontsource.
- **GSAP** — used by HyperFrames motion graphics under GreenSock's [standard no-charge license](https://gsap.com/standard-license).
- **Mediabunny** — MPL-2.0; used unmodified. Source and documentation: [mediabunny.dev](https://mediabunny.dev/).

Blender, Claude Code, Codex and the AI services Lumen can connect to are separate products that you install or sign up for yourself; they are not distributed with Lumen.
