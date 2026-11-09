/**
 * Zephyr's preset-scoped tool mask. The Desktop host mounts
 * `load_workspace_dependencies` globally; Zephyr resolves dependencies from the
 * global environment, so hide it for this preset only.
 * @module @liyang8246/dsh-zephyr/tool-mask
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'zephyr-tool-mask'

/** The tool registry this plugin restricts. */
export const inject = ['tools']

/** Global tools this preset hides; absent ones are skipped for other carriers. */
const MASKED = ['load_workspace_dependencies']

/**
 * Deny the masked global tools in this preset's scope. The Desktop host
 * registers its Office tool after presets load, so the mask waits for the
 * `tools/change` the registration emits.
 * @param ctx - the preset-scoped plugin context.
 */
export function apply(ctx: Context): void {
  let dispose: (() => void) | undefined
  let applying = false

  const mask = (): void => {
    if (applying || dispose !== undefined)
      return
    const deny = MASKED.filter(tool => ctx.tools.get(tool) !== undefined)
    if (deny.length === 0)
      return
    // `restrict` emits `tools/change`, which re-enters this listener.
    applying = true
    try {
      dispose = ctx.tools.restrict({ deny })
    }
    finally {
      applying = false
    }
  }

  mask()
  ctx.effect(() => {
    const off = ctx.on('tools/change', mask)
    return () => {
      off()
      dispose?.()
    }
  })
}
