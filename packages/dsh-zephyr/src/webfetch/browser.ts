/**
 * Headless Chromium for `render: true` fetches. Each call starts its own
 * browser and closes it again, so nothing stays resident between fetches. The
 * browser binary is never downloaded by this plugin: a missing Chromium is
 * reported, not repaired.
 * @module @liyang8246/dsh-zephyr/webfetch/browser
 */

import type { FetchFormat, RenderedPage } from './types.js'
import { chromium } from 'playwright-core'
import { htmlToMarkdown } from './html.js'
import { requireHttpUrl } from './http.js'

/** The installed-browser hint; this plugin never installs anything. */
const MISSING_BROWSER_HINT = 'web_fetch render mode needs the Playwright Chromium build, which is not installed. '
  + 'Run `npx playwright-core install chromium` once and retry. web_fetch never downloads browsers itself.'

/** Map a launch failure to an actionable message. */
function launchError(error: unknown): Error {
  const message = error instanceof Error
    ? error.message
    : String(error)
  if (/Executable doesn't exist|playwright install|install the browsers|browserType\.launch/iu.test(message))
    return new Error(MISSING_BROWSER_HINT)
  return new Error(`Chromium failed to start: ${message}`)
}

/**
 * Load one URL in a freshly launched headless Chromium and return the rendered
 * document.
 * @param rawUrl - the HTTP(S) URL to load.
 * @param format - wanted output format.
 * @param timeoutSeconds - wall-clock budget for the navigation.
 * @param waitMs - upper bound on waiting for async content after the document.
 * @param outerSignal - the tool call's cancellation signal.
 * @returns the rendered body and the URL that produced it.
 */
export async function renderPage(
  rawUrl: string,
  format: FetchFormat,
  timeoutSeconds: number,
  waitMs: number,
  outerSignal: AbortSignal,
): Promise<RenderedPage> {
  const url = requireHttpUrl(rawUrl)
  outerSignal.throwIfAborted()
  let browser
  try {
    browser = await chromium.launch({ headless: true })
  }
  catch (error) {
    throw launchError(error)
  }
  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
    })
    const page = await context.newPage()
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: timeoutSeconds * 1000,
    })
    // Sites that fill the page from an async request need this wait; it ends as
    // soon as the network goes quiet, so a static page pays almost nothing.
    await page.waitForLoadState('networkidle', { timeout: waitMs }).catch(() => {})
    outerSignal.throwIfAborted()
    const statusCode = response?.status() ?? 0
    if (statusCode >= 400)
      throw new Error(`HTTP ${statusCode}`)
    // innerText reflects the rendered layout — hidden nodes excluded, block
    // breaks kept — which is the point of a rendered fetch. textContent would
    // return hidden text with no line structure.
    const text = format === 'text'
      // eslint-disable-next-line unicorn/prefer-dom-node-text-content -- rendered text, not raw source
      ? (await page.evaluate(() => document.body?.innerText ?? '')).trim()
      : format === 'html'
        ? await page.content()
        : htmlToMarkdown(await page.content())
    return {
      url: page.url(),
      statusCode,
      text,
    }
  }
  finally {
    await browser.close().catch(() => {})
  }
}
