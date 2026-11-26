/** Tool names Kiro accepts verbatim. */
export declare const KIRO_TOOL_NAME: RegExp;
/** One request's tool names, in both directions. */
export interface ToolNames {
    /**
     * The name Kiro must receive for one harness tool.
     * @param name - the harness tool name.
     * @returns a name matching {@link KIRO_TOOL_NAME}.
     */
    wire: (name: string) => string;
    /**
     * The harness tool a wire name refers to.
     * @param name - the name Kiro streamed back.
     * @returns the harness name, or the input when it names no declared tool.
     */
    harness: (name: string) => string;
}
/**
 * Resolve the wire names one request declares.
 *
 * The mapping is a pure function of the name list, sorted internally: the same
 * tool set always yields the same wire names, so Kiro's prefix cache survives
 * across turns. Two harness names that encode alike — `a-b` and `a_b` — are
 * separated by a digest rather than by order, so one tool gaining or losing a
 * neighbour never renames the rest.
 * @param names - every harness tool name the request declares.
 * @returns the mapping used to declare the tools and to read the answer back.
 */
export declare function toolNames(names: readonly string[]): ToolNames;
