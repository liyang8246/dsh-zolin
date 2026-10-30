import type { Context } from '@deepseek-ai/cordis'
import assert from 'node:assert/strict'
import { it } from 'vitest'

import { apply, inject } from '../src/restrict.js'

function fixture(names: string[]) {
  let denied: string[] | undefined
  let disposed = false
  const cleanups: (() => void)[] = []
  let onChange: (() => void) | undefined
  const ctx = {
    tools: {
      schemas: () => names.map(name => ({ name })),
      restrict({ deny }: { deny: string[] }) {
        denied = deny
        onChange?.()
        return () => {
          disposed = true
        }
      },
    },
    effect(effect: () => () => void) { cleanups.push(effect()) },
    on(_event: string, callback: () => void) { onChange = callback },
  } as unknown as Context
  return {
    ctx,
    cleanups,
    change: () => onChange?.(),
    denied: () => denied,
    disposed: () => disposed,
  }
}

it('restrict hides only the inherited dependency loader and owns its cleanup', () => {
  const mock = fixture([
    'read',
    'uv_run',
    'load_workspace_dependencies',
    'zephyr_accounts',
  ])
  assert.deepEqual(inject, ['tools'])
  apply(mock.ctx)
  assert.deepEqual(mock.denied(), ['load_workspace_dependencies'])
  assert.equal(mock.cleanups.length, 1)
  mock.cleanups[0]!()
  assert.equal(mock.disposed(), true)
})

it('restrict hides the dependency loader registered after startup', () => {
  const names = ['read', 'uv_run']
  const mock = fixture(names)
  apply(mock.ctx)
  assert.equal(mock.denied(), undefined)
  names.push('load_workspace_dependencies')
  mock.change()
  mock.change()
  assert.deepEqual(mock.denied(), ['load_workspace_dependencies'])
  assert.equal(mock.cleanups.length, 1)
})
