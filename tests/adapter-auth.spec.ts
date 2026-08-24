import { describe, expect, it } from 'vitest'
import { kiroRequestEndpoint, kiroTokenTypeHeaders } from '../src/adapter.ts'
import type { KiroToken } from '../src/auth.ts'

function token(authMethod: KiroToken['authMethod']): KiroToken {
  return { accessToken: 'access', region: 'us-east-1', expiresAt: Date.now() + 60_000, authMethod }
}

describe('auth-specific Kiro request routing', () => {
  it('uses CodeWhisperer for IDC and external IdP tokens', () => {
    expect(kiroRequestEndpoint(token('idc'), 'eu-central-1'))
      .toBe('https://codewhisperer.eu-central-1.amazonaws.com/generateAssistantResponse')
    expect(kiroRequestEndpoint(token('external_idp'), 'us-east-1')).toContain('codewhisperer.')
    expect(kiroTokenTypeHeaders(token('external_idp'))).toEqual({ TokenType: 'EXTERNAL_IDP' })
  })

  it('uses Amazon Q and its token discriminator for API keys', () => {
    expect(kiroRequestEndpoint(token('api_key'), 'us-west-2'))
      .toBe('https://q.us-west-2.amazonaws.com/generateAssistantResponse')
    expect(kiroTokenTypeHeaders(token('api_key'))).toEqual({ TokenType: 'API_KEY' })
  })
})
