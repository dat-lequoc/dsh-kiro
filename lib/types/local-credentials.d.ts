/** Reuse the credential a Kiro CLI or Kiro IDE sign-in already stored. */
import type { LoginJsonTransport, ManagedCredentials } from './login.ts';
/** The credential one local Kiro installation already holds. */
export interface LocalKiroCredentials {
    credentials: ManagedCredentials;
    /** The store the credential was read from. */
    file: string;
    /** The `auth_kv` row that held the token. */
    key: string;
}
/** Where a local Kiro installation keeps its sign-in state. */
export interface LocalKiroCredentialOptions {
    /** Read this store instead of probing the platform locations. */
    file?: string;
    /** Environment the probe reads; defaults to the process environment. */
    env?: NodeJS.ProcessEnv;
}
/** The stores to probe, in the order a machine is most likely to have one. */
export declare function localKiroCredentialFiles(env?: NodeJS.ProcessEnv): string[];
/**
 * Read the credential a local Kiro CLI or Kiro IDE sign-in already stored.
 *
 * Organizations whose identity provider only trusts the Kiro IDE callback
 * cannot be signed into from this plugin: the browser lands back in the IDE,
 * which then holds the refreshable credential. Reusing that credential keeps
 * the login possible instead of asking the user to paste tokens by hand.
 * @param options - an explicit store path, or the environment to probe.
 * @returns the normalized credential plus where it was read from.
 */
export declare function readLocalKiroCredentials(options?: LocalKiroCredentialOptions): Promise<LocalKiroCredentials>;
/** An OAuth form POST, matching the transport the rest of the plugin uses. */
export type LocalKiroFormTransport = (url: string, form: URLSearchParams, signal: AbortSignal) => Promise<{
    status: number;
    body: unknown;
}>;
/**
 * Refresh a reused sign-in that the Kiro CLI left close to expiry.
 *
 * A CLI store is written when its owner signs in, so by the time the plugin
 * reuses it the access token is often already stale — but the refresh token
 * beside it still works. An external-IdP token refreshes as a form on the
 * endpoint that issued it; the identity-centre variants refresh through AWS
 * OIDC with the registration the store keeps beside the token.
 * @param credentials - what `readLocalKiroCredentials` read.
 * @param requestJson - transport for the provider's token endpoint.
 * @param signal - aborts the refresh.
 * @param requestForm - form transport, required to refresh an external IdP token.
 * @returns the same credential, or a refreshed copy when it was near expiry.
 */
export declare function refreshLocalKiroCredentials(credentials: ManagedCredentials, requestJson: LoginJsonTransport, signal: AbortSignal, requestForm?: LocalKiroFormTransport): Promise<ManagedCredentials>;
/** The rotated token fields a shared store has to learn about. */
export interface LocalKiroTokenUpdate {
    /** The store the credential was imported from. */
    file: string;
    /** The `auth_kv` row that holds the token. */
    key: string;
    accessToken: string;
    refreshToken?: string;
    expiresAt: string;
    scope?: string;
}
/**
 * Write a rotated token back into the store it was imported from.
 *
 * Reusing a sign-in makes the plugin and the Kiro CLI share one refresh token,
 * and a Microsoft refresh rotates it: whichever side refreshes first would
 * otherwise invalidate the other. Keeping the store current makes the reuse
 * safe in both directions.
 * @param update - the store row and the token fields to replace.
 */
export declare function writeLocalKiroToken(update: LocalKiroTokenUpdate): Promise<void>;
