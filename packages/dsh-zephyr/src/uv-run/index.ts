import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import { createDefinition } from './definition.js'

export const inject = [
  'tools',
  'shell',
  'workingDirectory',
  'sandboxPolicy',
]

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.tools.register(createDefinition(ctx)))
}
