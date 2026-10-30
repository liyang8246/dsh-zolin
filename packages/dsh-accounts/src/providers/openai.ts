// @env node
import type { LoginInteraction, LoginNotice, OAuthTokens } from '../shared/types.js'
import { registerBunOAuthFlows } from '@earendil-works/pi-ai/bun-oauth'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import { validateTokens } from '../shared/validation.js'

// pi's opaque OAuth import cannot resolve from the bundled Host artifact.
registerBunOAuthFlows()
const oauth = openaiCodexProvider().auth.oauth!

function freshTokens(value: unknown): OAuthTokens {
  const tokens = validateTokens(value)
  if (tokens.expires <= Date.now())
    throw new Error('OpenAI returned expired credentials')
  return tokens
}

export async function loginOpenAI(interaction: LoginInteraction): Promise<OAuthTokens> {
  let notice: LoginNotice = {}
  const notify = (next: LoginNotice): void => {
    notice = {
      ...notice,
      ...next,
    }
    interaction.notify({ ...notice })
  }
  try {
    const credential = await oauth.login({
      signal: interaction.signal,
      prompt: async (prompt) => {
        interaction.signal.throwIfAborted()
        return prompt.type === 'select'
          ? 'browser'
          : interaction.prompt(prompt.message, prompt.signal)
      },
      notify: (event) => {
        switch (event.type) {
          case 'auth_url':
            notify({ url: event.url, message: 'Complete sign-in in your browser, or paste the final redirect URL.' })
            break
          case 'device_code':
            notify({ url: event.verificationUri, code: event.userCode })
            break
          case 'info':
          case 'progress':
            notify({ message: event.message })
            break
        }
      },
    }, { agentName: 'dsh-zephyr' })
    interaction.signal.throwIfAborted()
    return freshTokens(credential)
  }
  catch {
    interaction.signal.throwIfAborted()
    // pi errors may include token endpoint bodies; never forward those to the UI.
    throw new Error('OpenAI sign-in failed; try again')
  }
}

export async function refreshOpenAI(tokens: OAuthTokens, signal?: AbortSignal): Promise<OAuthTokens> {
  const bounded = AbortSignal.any([
    AbortSignal.timeout(15_000),
    ...(signal
      ? [signal]
      : []),
  ])
  try {
    bounded.throwIfAborted()
    const credential = await oauth.refresh({ ...tokens, type: 'oauth' }, bounded)
    return freshTokens({
      ...tokens,
      ...credential,
    })
  }
  catch {
    bounded.throwIfAborted()
    throw new Error('OpenAI token refresh failed')
  }
}
