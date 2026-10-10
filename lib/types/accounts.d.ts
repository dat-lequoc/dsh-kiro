/**
 * Multi-account credential storage for Kiro.
 *
 * One versioned document ("accounts.json") holds every credential this plugin
 * owns, and exactly one of them is active. The single-file layout this plugin
 * shipped first is still readable: a directory holding only
 * "kiro-auth-token.json" presents that credential as one imported account until
 * the first mutation, which then writes the document and leaves the legacy file
 * where it was so older tooling and the CLI keep working.
 *
 * Two properties drive the shape:
 *
 * - A refresh must never resurrect or overwrite a login that happened while it
 *   was in flight, so every write is guarded by the account credential
 *   revision and applied under a cross-process lock.
 * - A credential is opaque data here. The store bounds, validates and preserves
 *   it, and never interprets token material; interpreting stays with the
 *   adapter own credential handling.
 *
 * @module dsh-kiro/accounts
 */
/** Document holding every account this plugin owns, inside the credential directory. */
export declare const KIRO_ACCOUNTS_FILE = "accounts.json";
/** Single-credential file earlier versions wrote, and the CLI still writes. */
export declare const KIRO_LEGACY_TOKEN_FILE = "kiro-auth-token.json";
/** Most accounts one installation may store. */
export declare const MAX_KIRO_ACCOUNTS = 16;
/** Largest accepted account document. */
export declare const KIRO_ACCOUNT_DOCUMENT_LIMIT: number;
/** One stored credential and the metadata the settings page shows. */
export interface KiroStoredAccount {
    /** Opaque local identifier; never derived from token material. */
    id: string;
    label: string;
    /** Recorded authentication method, in the vocabulary the adapter acts on. */
    authMethod: string;
    region?: string;
    profileArn?: string;
    createdAt: number;
    updatedAt: number;
    /** Increments on every credential write; guards refresh against concurrent logins. */
    credentialRevision: number;
    /** The credential record exactly as the adapter resolver expects it. */
    credential: Record<string, unknown>;
}
/** The whole account document, as persisted. */
export interface KiroAccountsDocument {
    version: 1;
    revision: number;
    activeAccountId: string | null;
    accounts: KiroStoredAccount[];
}
/** Credential-free account view for the settings page and the status API. */
export interface KiroAccountSummary {
    id: string;
    label: string;
    authMethod: string;
    region?: string;
    profileArn?: string;
    expiresAt?: number;
    active: boolean;
    createdAt: number;
    updatedAt: number;
    credentialRevision: number;
    /**
     * ready: the stored access token is still valid. refresh-required: it expired
     * and refresh must run. unusable: the record has neither a usable access token
     * nor a refresh token.
     */
    state: 'ready' | 'refresh-required' | 'unusable';
}
/** Account list plus the revision a mutation must quote to be accepted. */
export interface KiroAccountsSnapshot {
    revision: number;
    activeAccountId: string | null;
    accounts: KiroAccountSummary[];
    /** True while the document is still synthesized from the legacy token file. */
    migrated: boolean;
}
/** Fields one login or import supplies when it stores a credential. */
export interface KiroAccountUpsert {
    /** Raw credential record, in any shape the adapter resolver accepts. */
    credential: Record<string, unknown>;
    /** Human label; derived from the method and region when absent. */
    label?: string;
    /** Method recorded on the account when the credential does not name one. */
    authMethod?: string;
    region?: string;
    profileArn?: string;
    /** Target an existing account instead of adding one. */
    accountId?: string;
    /** Make the written account active. A first account always becomes active. */
    activate?: boolean;
    /** Reject the write when the document moved on. */
    expectedRevision?: number;
}
/** One account pinned for a request or a refresh, with revision-guarded writes. */
export interface CapturedKiroAccount {
    accountId: string;
    credentialRevision: number;
    /** Read this account's credential as it stands now. */
    read: () => Promise<Record<string, unknown> | undefined>;
    /**
     * Apply a credential change under the document lock. Returns the credential
     * in force afterwards: the change own result, or the one a concurrent login
     * installed while this call was waiting.
     */
    modify: (change: (current: Record<string, unknown>) => Record<string, unknown> | undefined | void) => Promise<Record<string, unknown> | undefined>;
}
/**
 * Human label for an account that was not given one.
 * @param authMethod - the account recorded method.
 * @param region - the account region, when known.
 * @returns a label naming the method and region.
 */
export declare function defaultAccountLabel(authMethod: string, region?: string): string;
/**
 * Owner-only persistent store for every Kiro credential this plugin owns.
 *
 * Reads are lock-free because writes replace the document atomically; every
 * mutation takes a cross-process lock first, so the Web settings page and the
 * `kiro-login` CLI can both write without losing each other work.
 */
export declare class KiroAccountStore {
    /** Absolute credential directory this store owns. */
    readonly directory: string;
    constructor(directory: string);
    /** Absolute path of the account document. */
    get documentPath(): string;
    /** Absolute path of the single-credential file earlier versions wrote. */
    get legacyPath(): string;
    /** Absolute path of one account device-registration file. */
    registrationPath(clientIdHash: string): string;
    /** Whether the multi-account document exists, written or empty. */
    exists(): Promise<boolean>;
    /** Create the credential directory and verify no component is shared. */
    private ensureDirectory;
    /**
     * Run one mutation under the document lock, taking over a lock whose owner
     * died on this host and leaving one another host holds alone until it ages out.
     * @param suffix - lock namespace, so account-scoped writes do not serialize with whole-document ones.
     * @param action - the mutation to run while the lock is held.
     * @returns the action result.
     */
    private withLock;
    /**
     * Remove a lock directory whose owner is gone, or which nobody claimed.
     * @param folder - the lock directory to inspect.
     */
    private reapLock;
    /** Read the document, synthesizing one from the legacy file when needed. */
    private load;
    /**
     * Replace the document atomically, leaving the legacy file untouched.
     * @param document - the complete document to persist.
     */
    private save;
    /**
     * Run one mutation and persist its result under a new revision.
     * @param action - the mutation, which edits the document in place.
     * @param options - optional revision guard and lock namespace.
     * @returns the action result.
     */
    private mutate;
    /**
     * Locate one stored account or fail.
     * @param document - the document to search.
     * @param accountId - the account to find.
     * @returns the stored account.
     */
    private account;
    /**
     * List every stored account, credential-free.
     * @returns the snapshot the settings page renders.
     */
    snapshot(): Promise<KiroAccountsSnapshot>;
    /**
     * Pin one account for a request or a refresh.
     * @param accountId - the account to pin; the active one when omitted.
     * @returns the pinned account, or null when the store holds none.
     */
    capture(accountId?: string): Promise<CapturedKiroAccount | null>;
    /**
     * Store a credential, updating an existing account or adding one.
     * @param input - the credential and the metadata that names it.
     * @returns the identifier of the account that now holds the credential.
     */
    upsert(input: KiroAccountUpsert): Promise<{
        accountId: string;
    }>;
    /**
     * Select the account later requests use.
     * @param accountId - the account to activate.
     * @param expectedRevision - document revision the caller read, when it wants conflict detection.
     * @returns the activated account identifier.
     */
    activate(accountId: string, expectedRevision?: number): Promise<{
        accountId: string;
    }>;
    /**
     * Remove one account, requiring a replacement when it is the active one and
     * others remain.
     * @param accountId - the account to remove.
     * @param options - replacement choice and optional revision guard.
     * @returns the removed account identifier and its credential, so the caller
     *   can also delete that account device registration.
     */
    remove(accountId: string, options?: {
        replacementId?: string;
        expectedRevision?: number;
    }): Promise<{
        accountId: string;
        credential: Record<string, unknown>;
    }>;
    /**
     * Sign out every account, keeping an empty document so the installation stays
     * explicitly signed out instead of falling back to the legacy file.
     * @returns every removed credential, so the caller can clean up registrations.
     */
    removeAll(): Promise<readonly {
        accountId: string;
        credential: Record<string, unknown>;
    }[]>;
}
