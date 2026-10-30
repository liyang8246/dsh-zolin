import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Script } from 'node:vm'
import { build } from 'tsdown'

// Harness loads classic scripts, never ESM or a second React runtime.
await build({
  entry: { client: 'src/client.tsx' },
  outDir: 'lib',
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  clean: false,
  dts: false,
  config: false,
  outputOptions: { entryFileNames: '[name].js' },
})
const artifact = new URL('../lib/client.js', import.meta.url)
const source = await readFile(artifact, 'utf8')
assert.doesNotThrow(() => new Script(source, { filename: artifact.pathname }))
console.log('Browser artifact passes classic-script syntax validation')
