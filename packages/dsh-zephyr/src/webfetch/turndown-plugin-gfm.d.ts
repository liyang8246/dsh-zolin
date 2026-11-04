/** Ambient types for `@joplin/turndown-plugin-gfm`, which ships none. */
declare module '@joplin/turndown-plugin-gfm' {
  import type TurndownService from 'turndown'

  /** The composite GitHub-flavored-markdown plugin (tables, strikethrough, task lists). */
  export const gfm: TurndownService.Plugin
}
