import assert from 'node:assert/strict'
import { call } from '../src/client/api.ts'

// Run after build; dependency declarations must survive bundling.
const host = await import(new URL('../lib/index.js', import.meta.url).href)
assert.ok(host.inject.includes('connection'))
assert.ok(host.inject.includes('sessions'))

const originalFetch = globalThis.fetch
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
Object.defineProperty(globalThis, 'document', {
  configurable: true,
  value: { baseURI: 'https://harness.test/mount/' },
})
const status = {
  configured: true,
  autoUpload: true,
  pending: 0,
  sessions: 1,
}
try {
  globalThis.fetch = async (input, options) => {
    assert.equal(String(input), 'https://harness.test/mount/api/codetime')
    assert.equal(options?.credentials, 'same-origin')
    assert.equal(options?.body, '{"action":"status"}')
    return Response.json(status)
  }
  assert.deepEqual(await call({ action: 'status' }), status)

  for (const code of [401, 403, 404, 500]) {
    globalThis.fetch = async () => new Response('not found', { status: code })
    await assert.rejects(call({ action: 'status' }), { message: `CodeTime HTTP ${code}` })
  }
  globalThis.fetch = async () => Response.json({ error: 'token must not be empty' }, { status: 400 })
  await assert.rejects(call({ action: 'save', token: '' }), { message: 'token must not be empty' })

  globalThis.fetch = async () => new Response('<html>wrong route</html>')
  await assert.rejects(call({ action: 'status' }), /invalid JSON response/)
  globalThis.fetch = async () => Response.json({})
  await assert.rejects(call({ action: 'status' }), /unexpected response/)

  const controller = new AbortController()
  controller.abort()
  await assert.rejects(call({ action: 'status' }, controller.signal), { name: 'AbortError' })
}
finally {
  globalThis.fetch = originalFetch
  if (originalDocument)
    Object.defineProperty(globalThis, 'document', originalDocument)
  else
    Reflect.deleteProperty(globalThis, 'document')
}
console.log('CodeTime settings dependency and HTTP regression checks passed')
