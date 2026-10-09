import {
  type LanguageModelV3CallOptions,
  type SharedV3Warning,
  UnsupportedFunctionalityError,
} from '@ai-sdk/provider';
import { NeedleError } from '../errors.js';
import type { JsonSchema, ToolSchema } from '../schema.js';

function unsupported(functionality: string, message: string): never {
  throw new UnsupportedFunctionalityError({ functionality, message });
}

export function settingsWarnings(options: LanguageModelV3CallOptions): SharedV3Warning[] {
  const warnings: SharedV3Warning[] = [];
  for (const feature of [
    'temperature',
    'topP',
    'topK',
    'presencePenalty',
    'frequencyPenalty',
    'seed',
    'stopSequences',
  ] as const) {
    if (options[feature] !== undefined)
      warnings.push({
        type: 'unsupported',
        feature,
        details: 'The local Needle WASM engine does not expose this setting.',
      });
  }
  if (options.providerOptions && Object.keys(options.providerOptions).length)
    warnings.push({
      type: 'unsupported',
      feature: 'providerOptions',
      details: 'This provider does not accept per-call provider options.',
    });
  return warnings;
}

export function prepareCall(options: LanguageModelV3CallOptions) {
  options.abortSignal?.throwIfAborted();
  const systems: string[] = [];
  const users: string[] = [];
  for (const message of options.prompt) {
    if (message.role === 'system') {
      if (users.length)
        unsupported('message history', 'System messages must precede the user prompt.');
      systems.push(message.content);
    } else if (message.role === 'user') {
      const parts: string[] = [];
      for (const part of message.content) {
        if (part.type !== 'text')
          unsupported(
            'multimodal input',
            'Needle accepts text input only; images, files and audio are not supported by this binding.',
          );
        parts.push(part.text);
      }
      users.push(parts.join('\n'));
    } else {
      unsupported(
        'message history',
        'The Needle binding accepts one text user turn plus optional system facts. Assistant history and tool-result continuations cannot be imported into the WASM session.',
      );
    }
  }
  const prompt = users[0];
  if (users.length !== 1 || prompt === undefined)
    unsupported(
      'message history',
      'Pass one text user turn to Needle. Use prompt for a single request.',
    );
  const warnings = settingsWarnings(options);
  let tools: ToolSchema[] = (options.tools ?? []).map((definition) => {
    if (definition.type !== 'function')
      unsupported('provider tools', 'Needle supports application-defined function tools only.');
    if (definition.inputSchema?.type !== 'object')
      unsupported('tool schema', `Tool ${definition.name} must have an object input schema.`);
    if (definition.strict !== undefined)
      warnings.push({
        type: 'unsupported',
        feature: `${definition.name}.strict`,
        details:
          'Needle constrains output with its own JSON grammar; AI SDK validates the returned input.',
      });
    if (definition.inputExamples?.length)
      warnings.push({ type: 'unsupported', feature: `${definition.name}.inputExamples` });
    if (definition.providerOptions && Object.keys(definition.providerOptions).length)
      warnings.push({ type: 'unsupported', feature: `${definition.name}.providerOptions` });
    return {
      name: definition.name,
      // The SDK accepts broader JSON Schema keywords; the engine handles its supported subset.
      parameters: definition.inputSchema as unknown as JsonSchema,
      ...(definition.description === undefined ? {} : { description: definition.description }),
    };
  });
  const format = options.responseFormat;
  const structured = format?.type === 'json';
  if (format?.type === 'json') {
    if (tools.length || (options.toolChoice && options.toolChoice.type !== 'auto'))
      unsupported(
        'structured output with tools',
        'Use an output schema or function tools in each Needle request, not both.',
      );
    if (format.schema?.type !== 'object')
      unsupported(
        'responseFormat',
        'Needle structured output requires an object JSON Schema, for example Output.object({ schema }).',
      );
    tools = [
      {
        name: 'extract',
        description:
          format.description ??
          (format.name
            ? `Extract ${format.name} from the input.`
            : 'Extract the requested structured fields from the input.'),
        parameters: format.schema as unknown as JsonSchema,
      },
    ];
  } else {
    if (!tools.length)
      unsupported(
        'free-form text',
        'Needle is a tool-calling and extraction model. Pass tools or an Output.object schema.',
      );
    if (options.toolChoice?.type === 'none') tools = [];
    if (options.toolChoice?.type === 'tool') {
      const name = options.toolChoice.toolName;
      tools = tools.filter((tool) => tool.name === name);
      if (!tools.length)
        throw new NeedleError('INVALID_ARGUMENT', `Unknown selected tool: ${name}.`);
    }
  }
  return {
    prompt,
    system: systems.join('\n'),
    tools,
    structured,
    warnings,
    required:
      structured || options.toolChoice?.type === 'required' || options.toolChoice?.type === 'tool',
    ...(options.maxOutputTokens === undefined ? {} : { maxOutputTokens: options.maxOutputTokens }),
  };
}
