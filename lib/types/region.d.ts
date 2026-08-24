/** Validation for AWS region values used to construct Kiro hostnames. */
/**
 * Normalize an AWS region before using it in an outbound hostname.
 * @param value - configured or credential-derived region.
 * @returns validated lowercase region.
 */
export declare function assertKiroRegion(value: string): string;
