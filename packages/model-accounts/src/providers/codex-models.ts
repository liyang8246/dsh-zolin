import type { CatalogModel, StoredAccount } from '../shared/types.js'
import { fetchJSON } from '../shared/http.js'
import { record } from '../shared/validation.js'

// Codex clients ask this endpoint for the models the signed-in ChatGPT account can use; it
// rejects a non-semver client_version, which otherwise only gates the payload shape.
const clientVersion = '0.165.0'
const maxOutputTokens = 128_000

function efforts(value: unknown): string[] {
  if (!Array.isArray(value))
    return []
  return [
    ...new Set(value.flatMap((item) => {
      const level = record(item, 'Codex reasoning level').effort
      return typeof level === 'string' && /^[a-z]+$/.test(level)
        ? [level]
        : []
    })),
  ]
}

export function parseCodexModels(input: unknown): CatalogModel[] {
  const models = record(input, 'Codex models').models
  if (!Array.isArray(models))
    throw new TypeError('Invalid Codex model list')
  const result: CatalogModel[] = []
  for (const value of models) {
    const model = record(value, 'Codex model')
    // `hide` covers internal and reserved entries; supported_in_api marks chat-completions models.
    if (model.supported_in_api !== true || model.visibility !== 'list')
      continue
    const id = model.slug
    const context = typeof model.context_window === 'number'
      ? model.context_window
      : model.max_context_window
    if (typeof id !== 'string' || !id || typeof context !== 'number' || !Number.isSafeInteger(context) || context <= 0)
      continue
    const modalities = Array.isArray(model.input_modalities)
      ? model.input_modalities
      : []
    const levels = efforts(model.supported_reasoning_levels)
    result.push({
      id,
      name: typeof model.display_name === 'string' && model.display_name
        ? model.display_name
        : id,
      contextWindow: context,
      maxTokens: Math.min(context, maxOutputTokens),
      input: [
        'text',
        ...(modalities.includes('image')
          ? ['image' as const]
          : []),
      ],
      reasoning: levels.length > 0,
      reasoningEfforts: levels,
    })
  }
  if (!result.length)
    throw new Error('Codex returned no usable models')
  return result.sort((a, b) => a.id.localeCompare(b.id, 'en'))
}

export async function fetchCodexModels(account: StoredAccount, signal?: AbortSignal): Promise<CatalogModel[]> {
  if (account.credential.kind !== 'oauth')
    throw new Error('Codex requires OAuth')
  const headers: Record<string, string> = { 'Authorization': `Bearer ${account.credential.tokens.access}`, 'User-Agent': 'dsh-zephyr/0.2.0' }
  if (account.credential.tokens.accountId)
    headers['chatgpt-account-id'] = account.credential.tokens.accountId
  return parseCodexModels(await fetchJSON(`https://chatgpt.com/backend-api/codex/models?client_version=${clientVersion}`, { headers }, signal))
}
