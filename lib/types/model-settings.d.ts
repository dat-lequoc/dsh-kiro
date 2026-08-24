/** Persistent Kiro model visibility and deterministic catalog ordering. */
import type { KiroCatalogModel } from './adapter.ts';
export interface KiroModelSettings {
    enabledModelIds: readonly string[];
    knownModelIds: readonly string[];
    updatedAt: number;
}
/** Default storage path; kept beside, but independent from, managed credentials. */
export declare function modelSettingsPath(): string;
/** Sort models by family, newest numeric version, then preferred variant. */
export declare function compareKiroModels(a: KiroCatalogModel, b: KiroCatalogModel): number;
/** Serialize model-settings writes so concurrent checkbox changes cannot race. */
export declare class FileModelSettingsStore {
    private readonly file;
    private chain;
    constructor(file?: string);
    read(): Promise<KiroModelSettings>;
    private write;
    private modify;
    /** Merge a fresh catalog, enabling first-run and newly discovered model ids. */
    mergeCatalog(models: readonly KiroCatalogModel[]): Promise<KiroModelSettings>;
    /** Persist an exact checkbox selection, constrained to the current catalog. */
    setEnabledModelIds(enabledModelIds: readonly string[], models: readonly KiroCatalogModel[]): Promise<KiroModelSettings>;
    /** Resolve enabled models; a missing settings file means all are enabled. */
    enabledModels(models: readonly KiroCatalogModel[]): Promise<readonly KiroCatalogModel[]>;
}
/** Project a full catalog into the compact checkbox API shape. */
export declare function modelSelection(store: FileModelSettingsStore, models: readonly KiroCatalogModel[]): Promise<{
    enabledModelIds: readonly string[];
    models: readonly (KiroCatalogModel & {
        enabled: boolean;
    })[];
}>;
