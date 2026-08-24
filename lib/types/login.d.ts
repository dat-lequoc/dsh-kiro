/** AWS Builder ID device login and DSH-owned credential persistence. */
/** JSON transport used by device authorization and polling. */
export type LoginJsonTransport = (url: string, body: unknown, signal: AbortSignal) => Promise<{
    status: number;
    body: unknown;
}>;
/** In-memory secret state for one device authorization. */
export interface DeviceLoginSession {
    clientId: string;
    clientSecret: string;
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    intervalSeconds: number;
    expiresAt: number;
    region: string;
}
/** Result of one device-token poll. */
export type DeviceLoginPoll = {
    status: 'pending';
    intervalSeconds: number;
} | {
    status: 'completed';
    credentials: DeviceCredentials;
};
/** Complete credential material returned after device authorization. */
export interface DeviceCredentials {
    accessToken: string;
    refreshToken: string;
    expiresAt: string;
    clientId: string;
    clientSecret: string;
    region: string;
}
/** Non-secret information suitable for a status API. */
export interface CredentialSummary {
    authenticated: boolean;
    expiresAt?: string;
    region?: string;
}
/**
 * Begin an AWS Builder ID device authorization.
 * @param region - AWS OIDC region.
 * @param requestJson - JSON transport, normally sharing the configured Kiro proxy.
 * @param signal - caller cancellation.
 * @returns the device session and browser verification URL.
 */
export declare function startDeviceLogin(region: string, requestJson: LoginJsonTransport, signal: AbortSignal): Promise<DeviceLoginSession>;
/**
 * Poll one Builder ID device authorization once.
 * @param session - state returned by {@link startDeviceLogin}.
 * @param requestJson - JSON transport.
 * @param signal - caller cancellation.
 * @returns pending state or complete credentials.
 */
export declare function pollDeviceLogin(session: DeviceLoginSession, requestJson: LoginJsonTransport, signal: AbortSignal): Promise<DeviceLoginPoll>;
/**
 * Save a completed device authorization beneath DSH home.
 * @param directory - managed credential directory.
 * @param credentials - complete device credentials.
 */
export declare function saveDeviceCredentials(directory: string, credentials: DeviceCredentials): Promise<void>;
/**
 * Read non-secret managed credential status.
 * @param directory - credential directory to inspect.
 * @returns authentication metadata, or an unauthenticated summary when absent.
 */
export declare function credentialSummary(directory: string): Promise<CredentialSummary>;
/**
 * Delete only credentials owned by this plugin, leaving Kiro IDE files intact.
 * @param directory - managed credential directory.
 */
export declare function deleteDeviceCredentials(directory: string): Promise<void>;
