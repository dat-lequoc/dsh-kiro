/** Validation and region extraction for Kiro CodeWhisperer profile ARNs. */

const PROFILE_ARN = /^arn:(?:aws|aws-us-gov|aws-cn):codewhisperer:([a-z]{2}(?:-[a-z0-9]+)+-[0-9]+):[0-9]{12}:profile\/[A-Za-z0-9+=,.@_-]+$/u

/** Validate a Kiro profile ARN before it reaches a request URL or body. */
export function assertKiroProfileArn(value: string): string {
  const profileArn = value.trim()
  if (!PROFILE_ARN.test(profileArn)) {
    throw new Error('dsh-kiro: invalid CodeWhisperer profile ARN')
  }
  return profileArn
}

/** Return the AWS region embedded in a validated profile ARN. */
export function profileRegion(value: string): string {
  const profileArn = assertKiroProfileArn(value)
  const match = PROFILE_ARN.exec(profileArn)
  if (match?.[1] === undefined) throw new Error('dsh-kiro: profile ARN contains no region')
  return match[1]
}
