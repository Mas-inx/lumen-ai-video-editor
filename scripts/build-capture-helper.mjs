#!/usr/bin/env node
// Builds native/bin/lumen-capture-helper.exe from native/capture-helper/*.cs.
//
// It uses the C# compiler that is part of every Windows 10 and 11 install (the
// .NET Framework one, C# 5), so there is nothing to install or download, here or
// on a GitHub windows-latest runner.
//
//   node scripts/build-capture-helper.mjs               build
//   node scripts/build-capture-helper.mjs --if-missing  build only when the exe is
//                                                       missing or older than a source
//
// Anywhere but Windows, or when the compiler is not there, it says so and exits 0:
// the helper is a Windows-only extra and nothing else in the build needs it.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const sourceDir = join(root, 'native', 'capture-helper')
const manifest = join(sourceDir, 'app.manifest')
const outDir = join(root, 'native', 'bin')
const exe = join(outDir, 'lumen-capture-helper.exe')
const rel = (p) => relative(root, p)

const args = process.argv.slice(2)
const unknown = args.filter((a) => a !== '--if-missing')
if (unknown.length > 0) {
  console.error(`capture helper: unknown option ${unknown.join(' ')} (the only option is --if-missing)`)
  process.exit(64)
}
const ifMissing = args.includes('--if-missing')

if (process.platform !== 'win32') {
  console.log(`capture helper: skipped, it is only built on Windows (this is ${process.platform})`)
  process.exit(0)
}

const csc = join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
if (!existsSync(csc)) {
  console.log(`capture helper: skipped, the .NET Framework C# compiler was not found at ${csc}`)
  process.exit(0)
}

const sources = readdirSync(sourceDir)
  .filter((name) => name.toLowerCase().endsWith('.cs'))
  .sort()
  .map((name) => join(sourceDir, name))
if (sources.length === 0) {
  console.error(`capture helper: no .cs files in ${rel(sourceDir)}`)
  process.exit(1)
}

if (ifMissing && existsSync(exe)) {
  const built = statSync(exe).mtimeMs
  const newest = Math.max(...[...sources, manifest].map((file) => statSync(file).mtimeMs))
  if (built > newest) {
    console.log(`capture helper: up to date (${rel(exe)})`)
    process.exit(0)
  }
}

mkdirSync(outDir, { recursive: true })

const cscArgs = [
  '/nologo',
  '/noconfig', // no csc.rsp: the helper references mscorlib and nothing else
  '/target:exe',
  '/platform:x64',
  '/optimize+',
  '/debug-',
  '/unsafe', // one loop reads the audio packet as floats
  '/warn:4',
  '/codepage:65001',
  '/utf8output',
  `/win32manifest:${manifest}`,
  `/out:${exe}`,
  ...sources,
]

const started = Date.now()
const result = spawnSync(csc, cscArgs, { cwd: root, encoding: 'utf8', windowsHide: true })
const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()

if (result.error) {
  console.error(`capture helper: could not run ${csc}: ${result.error.message}`)
  process.exit(1)
}
if (result.status !== 0) {
  if (output) console.error(output)
  console.error(`capture helper: the build failed (csc exit code ${result.status})`)
  process.exit(result.status || 1)
}
if (output) console.log(output) // warnings
console.log(`capture helper: built ${rel(exe)} (${statSync(exe).size} bytes) in ${Date.now() - started} ms`)
