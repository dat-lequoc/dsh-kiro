import type { GenerateOptions } from '@deepseek-ai/dsh-llm';
export interface ToolNames {
    toWire(name: string): string;
    fromWire(name: string): string;
}
/** One mapping for the declarations, history, and streamed calls of a request. */
export declare function createToolNames({ tools, messages }: Pick<GenerateOptions, 'tools' | 'messages'>): ToolNames;
