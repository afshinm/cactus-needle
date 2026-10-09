import type {
  JSONObject,
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
} from '@ai-sdk/provider';
import { NeedleError } from '../errors.js';
import { prepareCall } from './prepare-call.js';
import { type SessionFactory, withSession } from './session.js';

export class NeedleLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = 'v3';
  readonly provider = 'needle';
  readonly supportedUrls = {};

  constructor(
    readonly modelId: string,
    private readonly load: SessionFactory,
  ) {}

  private async generate(input: ReturnType<typeof prepareCall>, signal?: AbortSignal) {
    const raw = await withSession(
      this.load,
      {
        tools: input.tools,
        system: input.system,
        stateless: true,
        ...(input.maxOutputTokens === undefined ? {} : { maxOutputTokens: input.maxOutputTokens }),
      },
      signal,
      (session) =>
        session.complete(
          input.prompt,
          input.maxOutputTokens === undefined ? {} : { maxNewTokens: input.maxOutputTokens },
        ),
    );
    if (!raw.success)
      throw new NeedleError('ENGINE_ERROR', raw.error ?? 'Needle generation failed.');
    if (input.required && !raw.function_calls.length)
      throw new NeedleError(
        'ENGINE_ERROR',
        'Needle withheld the requested output. No accepted tool call was generated; suppressed calls are never promoted.',
      );
    const names = new Set(input.tools.map((tool) => tool.name));
    if (raw.function_calls.some((call) => !names.has(call.name)))
      throw new NeedleError(
        'INVALID_RESPONSE',
        'Needle returned a call to a tool outside this request.',
      );
    const content: LanguageModelV3GenerateResult['content'] = [];
    if (raw.reasoning) content.push({ type: 'reasoning', text: raw.reasoning });
    if (input.structured) {
      const record = raw.function_calls[0];
      if (raw.function_calls.length !== 1 || !record)
        throw new NeedleError(
          'INVALID_RESPONSE',
          'Structured extraction must return exactly one record.',
        );
      content.push({ type: 'text', text: JSON.stringify(record.arguments) });
    } else
      for (const call of raw.function_calls)
        content.push({
          type: 'tool-call',
          toolCallId: crypto.randomUUID(),
          toolName: call.name,
          input: JSON.stringify(call.arguments),
        });
    return {
      content,
      finishReason: {
        unified: !input.structured && raw.function_calls.length ? 'tool-calls' : 'stop',
        raw: raw.type,
      },
      // The C ABI reports throughput but no token counts. Unknown is not zero.
      usage: {
        inputTokens: {
          total: undefined,
          noCache: undefined,
          cacheRead: undefined,
          cacheWrite: undefined,
        },
        outputTokens: { total: undefined, text: undefined, reasoning: undefined },
      },
      providerMetadata: { needle: JSON.parse(JSON.stringify(raw)) as JSONObject },
      response: {
        id: crypto.randomUUID(),
        timestamp: new Date(),
        modelId: this.modelId,
        body: raw,
      },
      warnings: input.warnings,
    } satisfies LanguageModelV3GenerateResult;
  }

  async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
    return this.generate(prepareCall(options), options.abortSignal);
  }

  async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
    const input = prepareCall(options);
    const abort = new AbortController();
    const signal = options.abortSignal
      ? AbortSignal.any([abort.signal, options.abortSignal])
      : abort.signal;
    let cancelled = false;
    return {
      stream: new ReadableStream<LanguageModelV3StreamPart>({
        start: (controller) => {
          controller.enqueue({
            type: 'stream-start',
            warnings: [
              ...input.warnings,
              {
                type: 'compatibility',
                feature: 'streaming',
                details:
                  'Needle returns a complete result. Stream events are emitted after inference finishes; there are no token deltas from the engine.',
              },
            ],
          });
          void this.generate(input, signal)
            .then((result) => {
              if (cancelled) return;
              controller.enqueue({
                type: 'response-metadata',
                id: result.response.id,
                timestamp: result.response.timestamp,
                modelId: this.modelId,
              });
              if (options.includeRawChunks)
                controller.enqueue({ type: 'raw', rawValue: result.response.body });
              for (const part of result.content) {
                if (part.type === 'text' || part.type === 'reasoning') {
                  const id = crypto.randomUUID();
                  if (part.type === 'text') {
                    controller.enqueue({ type: 'text-start', id });
                    controller.enqueue({ type: 'text-delta', id, delta: part.text });
                    controller.enqueue({ type: 'text-end', id });
                  } else {
                    controller.enqueue({ type: 'reasoning-start', id });
                    controller.enqueue({ type: 'reasoning-delta', id, delta: part.text });
                    controller.enqueue({ type: 'reasoning-end', id });
                  }
                } else if (part.type === 'tool-call') {
                  controller.enqueue({
                    type: 'tool-input-start',
                    id: part.toolCallId,
                    toolName: part.toolName,
                  });
                  controller.enqueue({
                    type: 'tool-input-delta',
                    id: part.toolCallId,
                    delta: part.input,
                  });
                  controller.enqueue({ type: 'tool-input-end', id: part.toolCallId });
                  controller.enqueue(part);
                }
              }
              controller.enqueue({
                type: 'finish',
                usage: result.usage,
                finishReason: result.finishReason,
                providerMetadata: result.providerMetadata,
              });
              controller.close();
            })
            .catch((error: unknown) => {
              if (cancelled) return;
              controller.enqueue({ type: 'error', error });
              controller.close();
            });
        },
        cancel(reason: unknown) {
          cancelled = true;
          abort.abort(reason);
        },
      }),
    };
  }
}
