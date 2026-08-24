/** Validation and region extraction for Kiro CodeWhisperer profile ARNs. */
/** Validate a Kiro profile ARN before it reaches a request URL or body. */
export declare function assertKiroProfileArn(value: string): string;
/** Return the AWS region embedded in a validated profile ARN. */
export declare function profileRegion(value: string): string;
