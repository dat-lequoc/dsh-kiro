/** Kiro API endpoint resolution, mirroring the installed Kiro CLI's endpoint table. */
/** One published Kiro / Amazon Q Developer API endpoint. */
export interface KiroApiEndpoint {
    /** Absolute base URL of the regional API, without a trailing slash. */
    url: string;
    /** The AWS region this endpoint serves. */
    region: string;
}
/**
 * Resolve the Kiro API endpoint for one region.
 * @param region - any validated AWS region. The credential's recorded region is
 *   the SSO region and is often not a service region.
 * @returns the published endpoint serving that region, or the default endpoint.
 */
export declare function kiroApiEndpoint(region: string): KiroApiEndpoint;
