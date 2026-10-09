import type { ToolCall, ToolSet } from 'cactus-needle/browser';

export interface Demo {
  tools: ToolSet;
  examples: readonly { label: string; prompt: string }[];
  label: string;
  hint: string;
  prepare?(): Promise<void>;
  apply(calls: readonly ToolCall[]): void;
  deactivate?(): void;
}
