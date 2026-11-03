// @env browser
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { DshWindow } from '@deepseek-ai/dsh-client-modules/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { createSettings } from './client/settings.js'
import { en, zh } from './client/strings.js'

const dshWindow: Window & DshWindow = window
const loader = dshWindow.__ModuleLoader__
if (!loader || typeof loader.load !== 'function')
  throw new Error('Harness module loader is unavailable')

loader.load({
  id: '@liyang8246/dsh-codetime',
  factory(require) {
    const React = require('react') as typeof import('react')
    return {
      inject: ['slots', 'locale'],
      apply(ctx: Context): void {
        ctx.effect(() => ctx.locale.register('codetime', 'en', en))
        ctx.effect(() => ctx.locale.register('codetime', 'zh', zh))
        const t = ctx.locale.bind('codetime')
        const Settings = createSettings(React, ctx, t)

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'codetime',
          order: 14,
          label: () => t('title'),
        }, Settings))
      },
    }
  },
})
