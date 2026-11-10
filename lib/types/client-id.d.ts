/**
 * Kiro enforces a minimum client version. The plugin follows the update feed
 * and falls back to this pin. Bump the pin if requests fail with "no longer supported".
 */
import { getJson } from './transport.ts';
export declare const KIRO_CLIENT_VERSION = "1.4.121";
export declare function kiroUserAgent(): string;
export declare function refreshKiroClientVersion(proxyUrl: string | undefined, request?: typeof getJson): Promise<void>;
