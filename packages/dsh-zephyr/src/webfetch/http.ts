/**
 * URL and media-type helpers shared by the plain and rendered fetch paths.
 * @module @liyang8246/dsh-zephyr/webfetch/http
 */

/**
 * Reject anything that is not an absolute HTTP(S) URL.
 * @param value - candidate URL.
 * @returns the normalized URL.
 */
export function requireHttpUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new Error('URL must use http:// or https://')
  return url.href
}

/**
 * The bare media type of a content-type header, lowercased.
 * @param contentType - the header value.
 * @returns the media type without parameters.
 */
export function mimeOf(contentType: string): string {
  return contentType.split(';', 1)[0]?.trim().toLowerCase() ?? ''
}
