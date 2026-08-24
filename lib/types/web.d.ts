/** DSH Web API for Kiro login status and live model discovery. */
import type { Context } from '@deepseek-ai/cordis';
import '@deepseek-ai/dsh-host-webserver';
import type { KiroConnectionOptions } from './adapter.ts';
import type { KiroToken } from './auth.ts';
import type { KiroModelDiscovery } from './discovery.ts';
interface WebDependencies {
    managedDirectory: string;
    options: () => KiroConnectionOptions;
    discovery: KiroModelDiscovery;
    resolveToken: (connection: KiroConnectionOptions, signal: AbortSignal) => Promise<KiroToken>;
}
/**
 * Register the optional DSH Web management API.
 * @param ctx - owning Cordis context.
 * @param dependencies - credential and discovery services shared with the adapter.
 */
export declare function registerWebApi(ctx: Context, dependencies: WebDependencies): void;
export {};
