import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'

export const inject = ['tools']

const HIDDEN_TOOLS = ['load_workspace_dependencies']

export function apply(ctx: Context): void {
  let restricted = false
  function restrict(): void {
    if (restricted)
      return
    const visible = new Set(ctx.tools.schemas().map(schema => schema.name))
    const deny = HIDDEN_TOOLS.filter(name => visible.has(name))
    if (deny.length === 0)
      return
    restricted = true
    ctx.effect(() => ctx.tools.restrict({ deny }))
  }
  ctx.on('tools/change', restrict)
  restrict()
}
