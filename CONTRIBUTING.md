# Contributing to Lumen

Thanks for helping build an open, AI-native video editor. Bug reports, ideas, docs and code are all welcome.

## Getting started

You need **Windows 10 or 11**, **Node.js 24** and npm. [Blender](https://www.blender.org/download/) 4.2+ is optional (for 3D renders).

```bash
git clone <your fork>
cd lumen
npm install
npm run dev        # the desktop app with hot reload
```

| Command | What it does |
| --- | --- |
| `npm run dev` | Electron app with hot reload |
| `npm run dev:web` | The UI in a browser tab (no desktop features) — quick for layout work |
| `npm run typecheck` | TypeScript for the renderer and the main process |
| `npm test` | Unit tests (Vitest, plain Node) |
| `npm run build` | Typecheck + production build |
| `npm run pack` | Unpacked app in `release/win-unpacked` |
| `npm run dist` | Windows installer in `release/` |

## How Lumen is put together

The [architecture section of the README](README.md#architecture) has the map. Three rules keep it coherent:

1. **Every change to a project is a command.** Commands live in [`src/editor/commands.ts`](src/editor/commands.ts): a Zod schema, a description and a `run()` on an Immer draft. Anything dispatched through `dispatch()` is undoable, shows up in History — and becomes a tool the AI can call, automatically. Timeline rules that don't need React live in [`src/editor/ops.ts`](src/editor/ops.ts) and [`src/editor/smart.ts`](src/editor/smart.ts), and have unit tests.
2. **The AI uses the same tools as everyone.** Every brain (API models, local Claude Code / Codex, external MCP clients) gets the registry in [`src/integrations/agent-tools.ts`](src/integrations/agent-tools.ts). Purpose-built tools live in [`src/integrations/tools/`](src/integrations/tools): `vision.ts` (seeing), `inspect.ts` (reading and hearing), `control.ts` (acting).
3. **Secrets stay in the main process.** API keys and OAuth tokens are encrypted with the OS keychain in `electron/` and never reach the renderer.

### Adding a command

Add it to `commands.ts` with a clear `description` — it's also the AI's documentation, so say what it does, what the ids refer to and what it returns. Throw `CommandError` with a helpful message when the input can't work. Add a test in `src/editor/*.test.ts`.

### Adding an AI tool

Add an entry to the right file in `src/integrations/tools/`:

- Build the schema with the helpers in `kit.ts` (`obj`, `str`, `num`, …). Tools that take times use **seconds**; commands use frames.
- Return plain JSON, or `withImages(json, images)` when the model should see pictures.
- When something's wrong, throw an error that says how to recover (the kit's `clipById` / `assetById` already list valid ids).
- Group multi-step edits in `useEditor.getState().transaction(...)`, and roll back with `savepoint()` / `rollbackTo()` if a step fails.
- Cover it in [`src/integrations/tools/tools.test.ts`](src/integrations/tools/tools.test.ts).

## Tests

```bash
npm test                                   # everything
npx vitest run src/editor/ops.test.ts      # one file
npx vitest                                 # watch mode
```

Tests run in plain Node: media engines that need a GPU or a canvas are faked per test (see the top of `tools.test.ts`). Main-process code is tested with a mocked `electron` module (see `electron/files.test.ts`).

## Pull requests

- Keep each PR focused on one change, and describe how you checked it.
- CI runs the typecheck, the tests and a Windows build on every PR.
- For UI changes, add a screenshot. Use the design tokens (`accent`, `ai`, `fg-*`, `surface-*`) rather than raw colours.

## Releasing (maintainers)

1. Bump `version` in `package.json`.
2. Move the `Unreleased` notes in [`CHANGELOG.md`](CHANGELOG.md) under the new version, and optionally write `docs/releases/vX.Y.Z.md` for the Releases page.
3. Commit, then `git tag vX.Y.Z && git push origin vX.Y.Z`. The [Release workflow](.github/workflows/release.yml) builds the installer and publishes it with checksums.

By contributing you agree that your work is released under the project's [MIT license](LICENSE).
