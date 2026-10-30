// @env browser
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { DshWindow } from '@deepseek-ai/dsh-client-modules/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { createAccountsPage } from './client/accounts-page.js'
import { call } from './client/api.js'
import { createComposerQuota } from './client/composer-quota.js'
import { en, zh } from './client/constants.js'
import { createQuotaComponents } from './client/quota.js'
import { createAccountStore } from './client/store.js'

const dshWindow: Window & DshWindow = window
const loader = dshWindow.__ModuleLoader__
if (!loader || typeof loader.load !== 'function')
  throw new Error('Harness module loader is unavailable')

loader.load({
  id: 'dsh-model-accounts',
  factory(require) {
    const React = require('react') as typeof import('react')
    return {
      inject: ['slots', 'locale', 'modelDirectories'],
      apply(ctx: Context): void {
        ctx.effect(() => ctx.locale.register('zephyr-accounts', 'en', en))
        ctx.effect(() => ctx.locale.register('zephyr-accounts', 'zh', zh))
        const t = ctx.locale.bind('zephyr-accounts')

        const store = createAccountStore(() => call({ action: 'list' }))
        ctx.effect(() => () => store.dispose())
        const { Quota, QuotaBars } = createQuotaComponents(React, t)
        const ComposerQuota = createComposerQuota(React, ctx, store, QuotaBars)
        const AccountsPage = createAccountsPage(React, ctx, store, t, Quota)

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'zephyr-accounts',
          order: 12,
          label: () => t('title'),
        }, AccountsPage))
        ctx.slots.inject('conversation.input.right', () => ctx.slots.register({ name: 'conversation.input.right', id: 'zephyr-quota' }, ComposerQuota))
      },
    }
  },
})
