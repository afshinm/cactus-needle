import {
  type EmbeddingModelV3,
  type LanguageModelV3,
  NoSuchModelError,
  type ProviderV3,
} from '@ai-sdk/provider';
import { NeedleEmbeddingModel } from './embedding-model.js';
import { NeedleLanguageModel } from './language-model.js';
import type { SessionFactory } from './session.js';

/** A standard AI SDK provider. V3 is accepted by both AI SDK 6 and AI SDK 7. */
export interface NeedleProvider extends ProviderV3 {
  (modelId?: string): LanguageModelV3;
  languageModel(modelId?: string): LanguageModelV3;
  embeddingModel(modelId?: string): EmbeddingModelV3;
}

/** Platform entries supply the loader; the provider owns the SDK contract and lifecycle. */
export function bindProvider(load: SessionFactory): NeedleProvider {
  function check(modelId: string, modelType: 'languageModel' | 'embeddingModel') {
    if (modelId !== 'needle3') throw new NoSuchModelError({ modelId, modelType });
  }
  const languageModel = (modelId = 'needle3'): LanguageModelV3 => {
    check(modelId, 'languageModel');
    return new NeedleLanguageModel(modelId, load);
  };
  const embeddingModel = (modelId = 'needle3'): EmbeddingModelV3 => {
    check(modelId, 'embeddingModel');
    return new NeedleEmbeddingModel(modelId, load);
  };
  return Object.assign(languageModel, {
    specificationVersion: 'v3' as const,
    languageModel,
    embeddingModel,
    imageModel(modelId: string): never {
      throw new NoSuchModelError({ modelId, modelType: 'imageModel' });
    },
  });
}
