import type { EngineConfig } from '../runtime/protocol.js';

export interface WorkerConfig extends EngineConfig {
  modelPath: string;
  expectedSha256?: string;
}
