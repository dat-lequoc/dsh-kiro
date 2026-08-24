/** Validation for AWS region values used to construct Kiro hostnames. */

const REGION = /^[a-z]{2}(?:-[a-z0-9]+)+-[0-9]+$/u

/**
 * Normalize an AWS region before using it in an outbound hostname.
 * @param value - configured or credential-derived region.
 * @returns validated lowercase region.
 */
export function assertKiroRegion(value: string): string {
  const region = value.trim().toLowerCase()
  if (!REGION.test(region)) throw new Error(`dsh-kiro: invalid AWS region "${value}"`)
  return region
}
