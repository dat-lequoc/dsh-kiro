/** DSH-owned paths used by the Kiro login flow. */
/**
 * Return the directory containing credentials created by this plugin.
 * @returns an absolute directory below DSH home.
 */
export declare function credentialDirectory(): string;
/**
 * Return the directory holding the per-session credit ledgers.
 * @returns an absolute directory below DSH home.
 */
export declare function creditDirectory(): string;
