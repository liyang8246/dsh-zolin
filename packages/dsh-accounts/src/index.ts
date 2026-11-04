import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { AdapterRegistrationHandle } from '@deepseek-ai/dsh-llm'
import { ModelAccountsService } from './host/service.js'
import { safeError } from './shared/errors.js'
import { jsonResponse } from './shared/http.js'
import { createTransport } from './transport/adapter.js'

export const name = 'zephyr-model-accounts'
export const inject = [
  'llm',
  'credentials',
  'connection',
  'attachments',
]

export function apply(ctx: Context): void {
  const service = new ModelAccountsService(ctx)
  const transport = createTransport(ctx, (channel, signal) => service.accounts.resolve(channel, signal), service.catalog, (channel, signal) => service.refreshCatalog(channel, signal))
  ctx.effect(() => {
    let active = true
    let registration: AdapterRegistrationHandle | undefined
    let pending = Promise.resolve()
    const sync = () => {
      pending = pending.then(async () => {
        const providers = (await service.activeChannels()).map(channel => `zephyr-${channel}`)
        if (!active)
          return
        if (registration)
          registration.replace(providers)
        else if (providers.length)
          registration = ctx.llm.registerAdapter(providers, transport)
      }).catch((error) => { console.error('model-accounts: route update failed', safeError(error)) })
    }
    service.onChange = sync
    service.start()
    sync()
    return () => {
      active = false
      service.onChange = undefined
      service.dispose()
      registration?.()
    }
  })
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/zephyr-models',
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      try {
        const args = await jsonResponse(new Response(request.body), 64 * 1024)
        const value = await service.dispatch(args, request.signal)
        return Response.json(value, {
          headers: { 'Cache-Control': 'no-store' },
        })
      }
      catch (error) {
        return Response.json({
          error: safeError(error),
        }, {
          status: 400,
          headers: { 'Cache-Control': 'no-store' },
        })
      }
    },
  }))
}
