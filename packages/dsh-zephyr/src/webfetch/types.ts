/**
 * Shared vocabulary for the local `web_fetch` tool.
 * @module @liyang8246/dsh-zephyr/webfetch/types
 */

/** Output format requested by the model. */
export type FetchFormat = 'markdown' | 'text' | 'html'

/** One retrieved page, before or after a browser render. */
export interface FetchedPage {
  /** Final URL after allowed redirects. */
  url: string
  /** HTTP status code of the retrieved response. */
  statusCode: number
  /** Response content type as received. */
  contentType: string
  /** Converted body. */
  output: string
  /** True when the byte or character cap trimmed `output`. */
  truncated: boolean
}

/** A page rendered by headless Chromium. */
export interface RenderedPage {
  /** Final URL after browser navigation. */
  url: string
  /** Status code of the main document response; `0` when the navigation reported none. */
  statusCode: number
  /** Rendered body in the requested format. */
  text: string
}
