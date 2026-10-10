import { describe, expect, it } from 'vitest'
import { kiroRequestEndpoint, kiroTokenTypeHeaders } from '../src/adapter.ts'
import { kiroApiEndpoint } from '../src/endpoint.ts'
import type { KiroToken } from '../src/auth.ts'

function token(authMethod: KiroToken['authMethod']): KiroToken {
  return { accessToken: 'access', region: 'us-east-1', expiresAt: Date.now() + 60_000, authMethod }
}

describe('Kiro request routing', () => {
  it('routes every auth method through the published Amazon Q endpoints', () => {
    // The installed Kiro CLI addresses all auth methods through `q.<region>`,
    // which exists only in the two published regions; the older
    // `codewhisperer.<region>` spelling is an alias of the us-east-1 host and
    // exists nowhere else.
    expect(kiroRequestEndpoint(token('idc'), 'eu-central-1'))
      .toBe('https://q.eu-central-1.amazonaws.com/generateAssistantResponse')
    expect(kiroRequestEndpoint(token('external_idp'), 'us-east-1'))
      .toBe('https://q.us-east-1.amazonaws.com/generateAssistantResponse')
    expect(kiroTokenTypeHeaders(token('external_idp'))).toEqual({ TokenType: 'EXTERNAL_IDP' })
  })

  it('falls back to the default endpoint for a region the Q API does not serve', () => {
    // An IAM Identity Center start URL can live in a region the Q API does not
    // serve; deriving the host from that region produced a hostname with no DNS
    // record and a transport failure right after a successful IDC login.
    expect(kiroRequestEndpoint(token('idc'), 'ap-southeast-1'))
      .toBe('https://q.us-east-1.amazonaws.com/generateAssistantResponse')
    expect(kiroApiEndpoint('us-west-2')).toEqual({
      region: 'us-east-1',
      url: 'https://q.us-east-1.amazonaws.com',
    })
    expect(kiroApiEndpoint('eu-central-1')).toEqual({
      region: 'eu-central-1',
      url: 'https://q.eu-central-1.amazonaws.com',
    })
  })

  it('keeps the Amazon Q surface and its token discriminator for API keys', () => {
    expect(kiroRequestEndpoint(token('api_key'), 'us-east-1'))
      .toBe('https://q.us-east-1.amazonaws.com/generateAssistantResponse')
    expect(kiroTokenTypeHeaders(token('api_key'))).toEqual({ TokenType: 'API_KEY' })
  })
})
