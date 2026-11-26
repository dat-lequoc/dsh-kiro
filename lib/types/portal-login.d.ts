/** Kiro portal login: work email → organization → the company's own SSO. */
import type { ManagedCredentials } from './login.ts';
/** Kiro's own sign-in portal; the IDE can override it through `kiroAuthConfig.portalUrl`. */
export declare const DEFAULT_PORTAL_URL = "https://app.kiro.dev";
/**
 * The loopback ports Kiro's IDE listens on for this same flow. Reusing them
 * keeps one set of redirect URIs registered with the portal and the IdPs.
 */
export declare const CALLBACK_PORTS: readonly [3128, 4649, 6588, 8008, 9091, 49153, 50153, 51153, 52153, 53153];
export type PortalJsonTransport = (url: string, signal: AbortSignal) => Promise<{
    status: number;
    body: unknown;
}>;
export type PortalFormTransport = (url: string, form: URLSearchParams, signal: AbortSignal) => Promise<{
    status: number;
    body: unknown;
}>;
/** The organization the portal resolved an email to. */
export type PortalOrganization = {
    kind: 'external-idp';
    issuerUrl: string;
    clientId: string;
    region: string;
    scopes: string;
    loginHint?: string;
    audience?: string;
} | {
    kind: 'social';
    provider: 'google' | 'github';
    code: string;
    region: string;
} | {
    kind: 'identity-center';
    provider: 'builderid' | 'awsidc' | 'internal';
    startUrl: string;
    region: string;
};
/** Discovery document fields this login needs. */
export interface IdpDiscovery {
    authorizationEndpoint: string;
    tokenEndpoint: string;
    /** Present when the IdP offers the RFC 8628 device grant. */
    deviceAuthorizationEndpoint?: string;
}
export interface PortalLoginOptions {
    portalUrl?: string;
    ports?: readonly number[];
    timeoutMs?: number;
    /** Host the portal and the IdP redirect back to; loopback by default. */
    redirectHost?: string;
}
export interface ExternalIdpSignIn {
    /**
     * Device grant: the page the user types the code into. Authorization code
     * grant: the IdP authorization URL.
     */
    authUrl: string;
    /** Device grant only: the code the user types at `authUrl`. */
    userCode?: string;
    /** Resolves with Kiro-shaped credentials once the IdP hands them over. */
    credentials: Promise<ManagedCredentials>;
}
export interface PortalLogin {
    /** Open this so the user can type a work email. */
    portalUrl: string;
    /** Base redirect URI handed to the portal (`http://host:port`). */
    redirectUri: string;
    port: number;
    /** Resolves when the portal reports the organization behind that email. */
    organization: Promise<PortalOrganization>;
    /** Sign in through the organization's own IdP, for `external-idp` answers. */
    beginExternalIdp(organization: Extract<PortalOrganization, {
        kind: 'external-idp';
    }>, options?: {
        /**
         * Which grant to use. `auto` takes the device grant when the IdP offers
         * it and falls back to a loopback authorization code, the only route that
         * works for apps that registered no loopback redirect.
         */
        mode?: 'auto' | 'device' | 'loopback';
        /** Form transport for the IdP token endpoint. */
        request?: PortalFormTransport;
        /** JSON transport for the IdP discovery document. */
        discoveryRequest?: PortalJsonTransport;
        signal?: AbortSignal;
    }): Promise<ExternalIdpSignIn>;
    close(): Promise<void>;
}
/** RFC 7636 verifier/challenge pair; the portal and the IdP each get one. */
export declare function pkcePair(): {
    verifier: string;
    challenge: string;
};
/** Build the portal URL the IDE opens for the email sign-in form. */
export declare function portalSigninUrl(input: {
    portalUrl: string;
    state: string;
    codeChallenge: string;
    redirectUri: string;
}): string;
/**
 * Translate the portal callback into how its organization must be signed into.
 *
 * The portal resolves the email to an organization server-side and hands the
 * client only what that organization needs: an external IdP descriptor, a
 * social authorization code, or an IAM Identity Center start URL.
 */
export declare function parsePortalOrganization(params: URLSearchParams, expectedState: string): PortalOrganization;
/** Read an IdP's OIDC discovery document. */
export declare function discoverIdp(issuerUrl: string, request: PortalJsonTransport, signal: AbortSignal): Promise<IdpDiscovery>;
/**
 * Build the company IdP authorization URL.
 *
 * Kiro registers `kiro://kiro.oauth/callback` for the IDE; the same IdP
 * registrations accept a loopback URI, which lets a plugin finish the flow
 * without installing a URL-scheme handler.
 */
export declare function externalIdpAuthorizationUrl(input: {
    organization: Extract<PortalOrganization, {
        kind: 'external-idp';
    }>;
    discovery: IdpDiscovery;
    redirectUri: string;
    state: string;
    codeChallenge: string;
}): string;
/** Trade the IdP authorization code for the tokens Kiro itself would store. */
export declare function completeExternalIdpLogin(input: {
    organization: Extract<PortalOrganization, {
        kind: 'external-idp';
    }>;
    discovery: IdpDiscovery;
    code: string;
    codeVerifier: string;
    redirectUri: string;
    request: PortalFormTransport;
    signal: AbortSignal;
}): Promise<ManagedCredentials>;
/** What the IdP's device authorization endpoint hands back. */
export interface IdpDeviceAuthorization {
    userCode: string;
    verificationUri: string;
    verificationUriComplete?: string;
    expiresAt: string;
    intervalSeconds: number;
}
/**
 * Ask the IdP for a device code.
 *
 * This is the route that works for company apps registered with a vendor URL
 * scheme (`kiro://…`) and no loopback redirect: nothing has to be registered
 * on the machine, the user types a short code instead.
 */
export declare function startIdpDeviceAuthorization(input: {
    organization: Extract<PortalOrganization, {
        kind: 'external-idp';
    }>;
    discovery: IdpDiscovery;
    request: PortalFormTransport;
    signal: AbortSignal;
}): Promise<IdpDeviceAuthorization & {
    deviceCode: string;
}>;
/** Poll the IdP's token endpoint until the user finishes the device sign-in. */
export declare function pollIdpDeviceAuthorization(input: {
    organization: Extract<PortalOrganization, {
        kind: 'external-idp';
    }>;
    discovery: IdpDiscovery;
    deviceCode: string;
    intervalSeconds: number;
    expiresAt: string;
    request: PortalFormTransport;
    signal: AbortSignal;
}): Promise<ManagedCredentials>;
/** Default JSON transport for discovery lookups. */
export declare function defaultJsonTransport(url: string, signal: AbortSignal): Promise<{
    status: number;
    body: unknown;
}>;
/** Default form transport for the external IdP token endpoint. */
export declare function defaultFormTransport(url: string, form: URLSearchParams, signal: AbortSignal): Promise<{
    status: number;
    body: unknown;
}>;
/** Start the loopback listener the portal and the company IdP both call back on. */
export declare function startPortalLogin(options?: PortalLoginOptions, transport?: PortalJsonTransport, signal?: AbortSignal): Promise<PortalLogin>;
