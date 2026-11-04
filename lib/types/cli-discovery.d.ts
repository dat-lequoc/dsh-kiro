/**
 * Discover Kiro models and profile ARN through external sources that bypass
 * the network-dependent ListAvailableModels API:
 *
 * 1. `kiro-cli chat --list-models --format json` — the CLI does its own auth
 *    and model discovery, so it works even when the API endpoint is not
 *    directly reachable from this process.
 * 2. Kiro IDE/CLI's `profile.json` on disk — the profile ARN the signed-in
 *    client recorded, which is the same fact ListAvailableProfiles discovers.
 *
 * Both are best-effort fallbacks: the API-based discovery remains
 * authoritative when it succeeds, because only it advertises each model's
 * effort levels. {@link mergeCliCatalog} combines the two.
 *
 * @module dsh-kiro/cli-discovery
 */
import type { KiroCatalogModel } from './adapter.ts';
/**
 * Run `kiro-cli chat --list-models --format json` and parse the output.
 *
 * @returns the CLI's live model catalog, or `undefined` when the CLI is
 *   unavailable or fails (not installed, not logged in, timeout).
 */
export declare function discoverModelsFromCli(signal?: AbortSignal): Promise<KiroCatalogModel[] | undefined>;
/**
 * Combine the API catalog with the CLI catalog.
 *
 * The API entry wins for every model both report: only it carries the live
 * effort schema, output bounds, and input types. Models the CLI alone lists
 * are appended so the catalog never shrinks because one source lagged.
 * @param api - models from ListAvailableModels, in provider order.
 * @param cli - models from `kiro-cli --list-models`, or undefined.
 * @returns the API models followed by CLI-only models.
 */
export declare function mergeCliCatalog(api: readonly KiroCatalogModel[], cli: readonly KiroCatalogModel[] | undefined): KiroCatalogModel[];
/**
 * Read the profile ARN the signed-in Kiro IDE or CLI recorded on disk.
 *
 * Absence is normal — a personal account reaches the service without one —
 * so a missing or unreadable file yields `undefined`.
 * @param homeDir - root the candidate paths resolve against.
 * @returns the ARN from the first candidate that has one, or `undefined`.
 */
export declare function discoverProfileArnFromFile(homeDir?: string): Promise<string | undefined>;
