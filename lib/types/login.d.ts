/** Multi-method Kiro login and DSH-owned credential persistence. */
import type { KiroAuthMethod } from './auth.ts';
export declare const BUILDER_START_URL = "https://view.awsapps.com/start";
export type LoginJsonTransport = (url: string, body: unknown, signal: AbortSignal) => Promise<{
    status: number;
    body: unknown;
}>;
export type LoginGetTransport = (url: string, headers: Record<string, string>, signal: AbortSignal) => Promise<{
    status: number;
    body: unknown;
}>;
export interface DeviceLoginOptions {
    authMethod?: 'builder-id' | 'idc';
    startUrl?: string;
}
export interface DeviceLoginSession {
    clientId: string;
    clientSecret: string;
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    intervalSeconds: number;
    expiresAt: number;
    region: string;
    authMethod: 'builder-id' | 'idc';
    startUrl: string;
}
export type DeviceLoginPoll = {
    status: 'pending';
    intervalSeconds: number;
} | {
    status: 'completed';
    credentials: ManagedCredentials;
};
export interface SocialDeviceLoginSession {
    provider: 'google' | 'github';
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    intervalSeconds: number;
    expiresAt: number;
}
export type SocialDeviceLoginPoll = {
    status: 'pending';
    intervalSeconds: number;
} | {
    status: 'completed';
    credentials: ManagedCredentials;
};
export interface ManagedCredentials {
    accessToken: string;
    refreshToken?: string;
    expiresAt: string;
    region: string;
    authMethod: KiroAuthMethod;
    profileArn?: string;
    clientId?: string;
    clientSecret?: string;
    startUrl?: string;
    tokenEndpoint?: string;
    scope?: string;
}
/** Backward-compatible name for device-flow credentials. */
export type DeviceCredentials = ManagedCredentials;
export interface CredentialSummary {
    authenticated: boolean;
    expiresAt?: string;
    region?: string;
    authMethod?: KiroAuthMethod;
    profileArn?: string;
}
/**
 * Begin Kiro's coded device authorization for a free or IAM Identity Center account.
 */
export declare function startDeviceLogin(region: string, requestJson: LoginJsonTransport, signal: AbortSignal, options?: DeviceLoginOptions): Promise<DeviceLoginSession>;
/** Poll one device authorization once. */
export declare function pollDeviceLogin(session: DeviceLoginSession, requestJson: LoginJsonTransport, signal: AbortSignal): Promise<DeviceLoginPoll>;
/** Begin Kiro's headless Google or GitHub device authorization. */
export declare function startSocialDeviceLogin(provider: 'google' | 'github', requestJson: LoginJsonTransport, signal: AbortSignal): Promise<SocialDeviceLoginSession>;
/** Poll one Kiro Google/GitHub device authorization once. */
export declare function pollSocialDeviceLogin(session: SocialDeviceLoginSession, requestJson: LoginJsonTransport, signal: AbortSignal): Promise<SocialDeviceLoginPoll>;
/**
 * Where an imported refresh token came from. The origin decides the refresh
 * endpoint and the recorded auth method, and the recorded method decides which
 * upstream request surface every later turn uses, so it cannot be guessed from
 * the presence of client credentials alone: AWS Builder ID and IAM Identity
 * Center credentials both carry a client id and secret.
 */
export type RefreshTokenOrigin = 'builder-id' | 'idc' | 'imported';
/**
 * Resolve the credential origin for one refresh-token import.
 * @param requested - the explicit origin the caller named, if any.
 * @param hasClientCredentials - whether an OIDC client id and secret were supplied.
 * @param resolvedStartUrl - the normalized start URL, if any.
 * @returns the origin to record.
 * @throws when the named origin contradicts the supplied credentials.
 */
export declare function resolveRefreshTokenOrigin(requested: RefreshTokenOrigin | undefined, hasClientCredentials: boolean, resolvedStartUrl: string | undefined): RefreshTokenOrigin;
/** Validate and refresh an imported Kiro refresh token. */
export declare function importRefreshToken(input: {
    refreshToken: string;
    region?: string;
    profileArn?: string;
    clientId?: string;
    clientSecret?: string;
    startUrl?: string;
    /** Explicit credential origin; omitted falls back to derivation. */
    authMethod?: RefreshTokenOrigin;
}, requestJson: LoginJsonTransport, signal: AbortSignal): Promise<ManagedCredentials>;
/** Validate a long-lived Kiro API key against its actual model catalog. */
export declare function importApiKey(apiKey: string, regionValue: string | undefined, requestGet: LoginGetTransport, signal: AbortSignal): Promise<ManagedCredentials>;
/** Convert CLIProxyAPI-compatible Microsoft external-IdP JSON into managed credentials. */
export declare function importExternalIdp(raw: unknown): ManagedCredentials;
/** Save any normalized credential beneath DSH home with private permissions. */
export declare function saveManagedCredentials(directory: string, credentials: ManagedCredentials): Promise<void>;
export declare function saveDeviceCredentials(directory: string, credentials: DeviceCredentials): Promise<void>;
/** Read only non-secret managed credential metadata for the status API. */
export declare function credentialSummary(directory: string): Promise<CredentialSummary>;
/** Delete only credentials owned by this plugin, leaving Kiro IDE files intact. */
export declare function deleteDeviceCredentials(directory: string): Promise<void>;
