import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { AdapterRegistrationHandle } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { channels } from './channels.js'
import { safeError } from './errors.js'
import { jsonResponse } from './http.js'
import { ModelAccountsService } from './service.js'
import { createTransport } from './transport.js'

export const name = 'zephyr-model-accounts'
export const inject = [
  'llm',
  'credentials',
  'connection',
  'tools',
  'attachments',
]

function accountTool(service: ModelAccountsService): ToolDefinition {
  return {
    name: 'zephyr_accounts',
    description: 'List model-channel accounts, select one active account per channel, rename/remove a saved login, or refresh quota. Removal does not revoke upstream access. Login and API-key entry are user-only in Settings → Model Accounts. Never returns tokens.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'list',
            'activate',
            'deactivate',
            'rename',
            'remove',
            'refresh_quota',
          ],
        },
        channel: {
          type: 'string',
          enum: channels.map(channel => channel.id),
          description: 'Required for activate/deactivate.',
        },
        id: { type: 'string', description: 'Account id returned by list. Required for activate/rename/remove; omit to refresh all quotas.' },
        label: { type: 'string', description: 'New display label, required for rename.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [
        {
          type: 'text',
          text: JSON.stringify(value),
        },
      ],
    },
    execute: (args, exec) => service.dispatch(args, 'agent', exec.signal),
  }
}

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
  ctx.effect(() => ctx.tools.register(accountTool(service)))
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/zephyr-models',
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      try {
        const args = await jsonResponse(new Response(request.body), 64 * 1024)
        const value = await service.dispatch(args, 'ui', request.signal)
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
