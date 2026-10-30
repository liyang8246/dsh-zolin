import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { JSON_SCHEMA, load, Type } from 'js-yaml'

import { it } from 'vitest'

interface Row {
  id: string
  name: string
  group?: boolean
  config?: Record<string, unknown> | Row[]
  disabled?: { __jsExpr: string }
  isolate?: Record<string, boolean>
}

const schema = JSON_SCHEMA.extend(new Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  construct: (expression: string) => ({ __jsExpr: expression }),
}))
const source = await readFile('cordis.patch.yml', 'utf8')
const patches = load(source, { schema }) as { insert: Row[] }[]
const preset = patches[0]!.insert[0]!
const config = preset.config as { id: string, plugins: Row[] }

function row(id: string): Row {
  const found = config.plugins.find(plugin => plugin.id === id)
  assert.ok(found, `missing preset plugin ${id}`)
  return found
}

it('the bundle declares one stable Zephyr preset and no account or model defaults', () => {
  assert.equal(patches.length, 1)
  assert.equal(patches[0]!.insert.length, 1)
  assert.equal(preset.id, 'preset-zephyr')
  assert.equal(preset.name, '@deepseek-ai/dsh-agent-preset')
  assert.equal(config.id, 'zephyr')
  assert.doesNotMatch(source, /zephyr-model-accounts|zephyr_accounts|agent-default-model|dsh-model-accounts/)
  assert.equal(row('zephyr-tools').name, 'dsh-zephyr-preset/restrict')
  assert.equal(row('uv-run').name, 'dsh-zephyr-preset/uv-run')
})

it('the original persona stays byte-identical after YAML parsing', () => {
  const prefix = (row('persona').config as { prefix: string }).prefix
  assert.equal(createHash('sha256').update(prefix).digest('hex'), '49ccbdb2bb3d8904763066dc4762e3c56c170a9f9630570660c993e840c3128b')
})

it('platform expressions stay inert and compaction keeps its nested entry list', () => {
  assert.deepEqual(row('tool-pwsh').disabled, { __jsExpr: 'process.platform !== \'win32\'' })
  assert.deepEqual(row('tool-bash').disabled, { __jsExpr: 'process.platform === \'win32\'' })
  const group = row('compaction')
  assert.equal(group.name, 'cordis:group')
  assert.equal(group.group, true)
  assert.deepEqual(group.isolate, { compaction: true, toolResultPruner: true })
  assert.ok(Array.isArray(group.config))
  assert.deepEqual(group.config.map(plugin => plugin.id), ['compaction-basic', 'command-compact', 'tool-result-pruner'])
})

it('the package exports only preset tools and display resources without client or provider code', async () => {
  const manifest = JSON.parse(await readFile('package.json', 'utf8'))
  assert.equal(manifest.name, 'dsh-zephyr-preset')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(Object.hasOwn(manifest.dsh, 'client'), false)
  assert.equal(Object.hasOwn(manifest.exports, '.'), false)
  assert.equal(Object.hasOwn(manifest.exports, './client'), false)
  assert.equal(manifest.exports['./uv-run'], './lib/uv-run.js')
  assert.equal(manifest.exports['./restrict'], './lib/restrict.js')
  assert.ok(Object.keys(manifest.devDependencies).every(name => name.startsWith('@deepseek-ai/')))
  assert.equal(manifest.dependencies, undefined)
  for (const language of ['en', 'zh']) {
    const locale = JSON.parse(await readFile(`locale/${language}.json`, 'utf8'))
    assert.ok(locale.meta.title)
    assert.ok(locale.meta.description)
  }
})
