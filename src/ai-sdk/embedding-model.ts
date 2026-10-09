import type {
  EmbeddingModelV3,
  EmbeddingModelV3CallOptions,
  EmbeddingModelV3Result,
} from '@ai-sdk/provider';
import { settingsWarnings } from './prepare-call.js';
import { type SessionFactory, withSession } from './session.js';

export class NeedleEmbeddingModel implements EmbeddingModelV3 {
  readonly specificationVersion = 'v3';
  readonly provider = 'needle';
  readonly maxEmbeddingsPerCall = Infinity;
  readonly supportsParallelCalls = false;

  constructor(
    readonly modelId: string,
    private readonly load: SessionFactory,
  ) {}

  async doEmbed(options: EmbeddingModelV3CallOptions): Promise<EmbeddingModelV3Result> {
    options.abortSignal?.throwIfAborted();
    const warnings = settingsWarnings({ prompt: [], ...options });
    if (!options.values.length) return { embeddings: [], warnings };
    const embeddings = await withSession(
      this.load,
      { tools: [], system: '', stateless: true },
      options.abortSignal,
      async (session) => {
        const vectors: number[][] = [];
        for (const value of options.values) {
          options.abortSignal?.throwIfAborted();
          vectors.push(Array.from(await session.embed(value)));
        }
        return vectors;
      },
    );
    return { embeddings, warnings };
  }
}
