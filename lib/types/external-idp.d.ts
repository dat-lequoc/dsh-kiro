/** Kiro Microsoft external-IdP credential normalization and refresh safety. */
/** Restrict imported token endpoints to Microsoft's real login hosts. */
export declare function assertMicrosoftTokenEndpoint(value: string): string;
/** Normalized external-IdP credential accepted from CLIProxyAPI-compatible JSON. */
export interface ExternalIdpCredentials {
    accessToken: string;
    refreshToken: string;
    expiresAt: string;
    region: string;
    profileArn: string;
    clientId: string;
    tokenEndpoint: string;
    scope: string;
    authMethod: 'external_idp';
}
/** Parse snake_case or camelCase CLIProxyAPI Kiro auth JSON. */
export declare function normalizeExternalIdpCredentials(raw: unknown): ExternalIdpCredentials;
