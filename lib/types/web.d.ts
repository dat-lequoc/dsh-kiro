/** DSH Web API for multi-method Kiro login, credential import, and model discovery. */
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
/** Register the optional DSH Web management API. */
export declare function registerWebApi(ctx: Context, dependencies: WebDependencies): void;
export {};
