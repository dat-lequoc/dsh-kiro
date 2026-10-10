/** Kiro API endpoint resolution, mirroring the installed Kiro CLI's endpoint table. */

import { assertKiroRegion } from './region.ts'

/** One published Kiro / Amazon Q Developer API endpoint. */
export interface KiroApiEndpoint {
  /** Absolute base URL of the regional API, without a trailing slash. */
  url: string
  /** The AWS region this endpoint serves. */
  region: string
}

/**
 * The only endpoints the installed Kiro CLI knows. Its `chat-cli` keeps exactly
 * this table and resolves the account profile region against it, falling back
 * to the default endpoint for any other region. `q.<region>.amazonaws.com` has
 * DNS records only in these two regions: the older `codewhisperer.<region>`
 * spelling is an alias of the us-east-1 host and exists nowhere else, so a
 * credential whose SSO region is different (for example an IAM Identity Center
 * instance in `ap-southeast-1`) must not derive its request host from that
 * region — the hostname simply does not exist.
 */
const KIRO_ENDPOINTS: readonly KiroApiEndpoint[] = [
  { region: 'us-east-1', url: 'https://q.us-east-1.amazonaws.com' },
  { region: 'eu-central-1', url: 'https://q.eu-central-1.amazonaws.com' },
]

const DEFAULT_ENDPOINT: KiroApiEndpoint = {
  region: 'us-east-1',
  url: 'https://q.us-east-1.amazonaws.com',
}

/**
 * Resolve the Kiro API endpoint for one region.
 * @param region - any validated AWS region. The credential's recorded region is
 *   the SSO region and is often not a service region.
 * @returns the published endpoint serving that region, or the default endpoint.
 */
export function kiroApiEndpoint(region: string): KiroApiEndpoint {
  const normalized = assertKiroRegion(region)
  return KIRO_ENDPOINTS.find(endpoint => endpoint.region === normalized) ?? DEFAULT_ENDPOINT
}
