/**
 * Per-turn Kiro credit ledger.
 *
 * Kiro reports what each model call cost in a `meteringEvent`
 * (`{ usage, unit: "credit" }`) inside the response stream. DSH's usage schema
 * has no credit vocabulary, so the adapter hands each charge to this ledger
 * keyed by the request's session, and the settings client sums the charges
 * that landed inside one Turn's start/end window to show "X credits" on that
 * Turn's reply. Every charge is timestamped when its event arrives, which is
 * always between the owning Turn's `turn/start` and `turn/end`.
 *
 * One append-only JSONL file per session, `{"t":<epoch ms>,"c":<credits>}` per
 * line, so a write is one `appendFile` and a crash can lose at most the line it
 * was writing. The ledger never throws into the stream: a failed write only
 * means that call's charge is not shown.
 */
/** Session identifiers the ledger accepts; anything else would escape the directory. */
export declare const CREDIT_SESSION_PATTERN: RegExp;
/** Credits charged inside one window. `calls` is zero when nothing was recorded. */
export interface KiroCreditSum {
    credits: number;
    calls: number;
}
/** Record and sum per-session Kiro credit charges. */
export declare class KiroCreditLedger {
    private readonly directory;
    private ready;
    /** @param directory - private directory holding one ledger file per session. */
    constructor(directory: string);
    private fileFor;
    /**
     * Append one charge. Fire-and-forget: the returned promise settles once the
     * line is written and never rejects, so callers in the stream may ignore it.
     * @param sessionId - DSH session that issued the request.
     * @param credits - non-negative credits the call consumed.
     * @param time - arrival time of the metering event.
     */
    record(sessionId: string, credits: number, time?: number): Promise<void>;
    /**
     * Sum the charges recorded for one session inside `[from, to]`.
     * @throws Error when `sessionId` is not a safe ledger name.
     */
    sum(sessionId: string, from: number, to: number): Promise<KiroCreditSum>;
}
