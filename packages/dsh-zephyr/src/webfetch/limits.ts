/**
 * Fixed limits of the local `web_fetch` tool. These are robustness budgets,
 * not deployment tunables.
 * @module @liyang8246/dsh-zephyr/webfetch/limits
 */

/** Redirect hops followed before the fetch fails. */
export const MAX_REDIRECTS = 10
/** Largest response body the tool reads, in bytes. */
export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024
/** Cap on the rendered result, keeping the model's context bounded. */
export const MAX_OUTPUT_CHARS = 200_000
/** Default per-request wall-clock budget, in seconds. */
export const DEFAULT_TIMEOUT_SECONDS = 30
/** Largest per-request wall-clock budget the model may ask for, in seconds. */
export const MAX_TIMEOUT_SECONDS = 120
/** Default wait for async content after a rendered document arrives, in milliseconds. */
export const DEFAULT_WAIT_MS = 4_000
/** Largest async-content wait the model may ask for, in milliseconds. */
export const MAX_WAIT_MS = 30_000
