import { errorMessage, NeedleError } from './errors.js';
import type { JsonSchema, JsonValue, ToolDefinition } from './schema.js';

/** Structural subset of Standard JSON Schema V1; supported by Zod 4.2+ and other schema libraries. */
export interface StandardJsonSchema<Input = unknown> {
  readonly '~standard': {
    readonly version: 1;
    readonly types?: { readonly input: Input; readonly output: unknown } | undefined;
    readonly jsonSchema: {
      readonly input: (options: { readonly target: 'draft-07' }) => Record<string, unknown>;
    };
    readonly validate?: (
      value: unknown,
    ) =>
      | { readonly issues?: readonly unknown[] | undefined; readonly value?: unknown }
      | Promise<{ readonly issues?: readonly unknown[] | undefined; readonly value?: unknown }>;
  };
}

declare const inputType: unique symbol;

export interface Tool<Input = unknown> {
  readonly description?: string;
  readonly inputSchema: JsonSchema;
  readonly triggers?: readonly string[];
  /** Used only by Needle.run(); complete() and generate() never execute tools. */
  execute?(input: Input, context: { abortSignal: AbortSignal }): unknown | Promise<unknown>;
  readonly [inputType]?: Input;
}

export type ToolSet = Readonly<Record<string, Tool>>;
export type ToolCollection = ToolSet | readonly ToolDefinition[];

type RequiredKeys<S> = S extends { readonly required: readonly (infer K)[] }
  ? Extract<K, string>
  : never;
type SchemaType<S, Depth extends unknown[] = []> = Depth['length'] extends 8
  ? unknown
  : S extends { readonly $ref: string }
    ? unknown
    : S extends { readonly const: infer Value }
      ? Value
      : S extends { readonly enum: readonly (infer Value)[] }
        ? Value
        : S extends { readonly type: 'string' }
          ? string
          : S extends { readonly type: 'number' | 'integer' }
            ? number
            : S extends { readonly type: 'boolean' }
              ? boolean
              : S extends { readonly type: 'null' }
                ? null
                : S extends { readonly type: 'array'; readonly items: infer Item }
                  ? SchemaType<Item, [...Depth, 0]>[]
                  : S extends { readonly type: 'object'; readonly properties: infer Properties }
                    ? {
                        -readonly [K in keyof Properties as K extends RequiredKeys<S>
                          ? K
                          : never]-?: SchemaType<Properties[K], [...Depth, 0]>;
                      } & {
                        -readonly [K in keyof Properties as K extends RequiredKeys<S>
                          ? never
                          : K]?: SchemaType<Properties[K], [...Depth, 0]>;
                      }
                    : unknown;

export type InferSchema<S> = S extends StandardJsonSchema
  ? NonNullable<S['~standard']['types']>['input']
  : SchemaType<S>;

interface ToolOptions<Schema, Input = InferSchema<Schema>> {
  description?: string;
  inputSchema: Schema;
  triggers?: readonly string[];
  execute?: Tool<Input>['execute'];
}

const validators = new WeakMap<Tool, NonNullable<StandardJsonSchema['~standard']['validate']>>();

export async function validateToolInput(definition: Tool, input: unknown): Promise<void> {
  const validate = validators.get(definition);
  if (validate && (await validate(input)).issues)
    throw new NeedleError('INVALID_ARGUMENT', 'Tool input failed schema validation.');
}

/** Define a named tool's input once; its name comes from the tools object key. */
export function tool<S extends StandardJsonSchema>(
  options: ToolOptions<S>,
): Tool<NonNullable<S['~standard']['types']>['input']>;
export function tool<const S extends JsonSchema>(options: ToolOptions<S>): Tool<SchemaType<S>>;
export function tool(options: ToolOptions<JsonSchema | StandardJsonSchema>): Tool {
  let schema = options.inputSchema;
  let validate: StandardJsonSchema['~standard']['validate'];
  if (!schema || typeof schema !== 'object')
    throw new NeedleError('INVALID_ARGUMENT', 'inputSchema must be an object schema.');
  if ('~standard' in schema) {
    const standard = (schema as StandardJsonSchema)['~standard'];
    if (standard?.version !== 1 || typeof standard.jsonSchema?.input !== 'function') {
      throw new NeedleError(
        'INVALID_ARGUMENT',
        'Use a Standard JSON Schema library (such as Zod 4.2+) or a plain JSON Schema.',
      );
    }
    try {
      schema = standard.jsonSchema.input({ target: 'draft-07' });
      if (standard.validate) validate = standard.validate.bind(standard);
    } catch (cause) {
      throw new NeedleError(
        'INVALID_ARGUMENT',
        `Cannot convert inputSchema: ${errorMessage(cause)}`,
        { cause },
      );
    }
  }
  if (schema.type !== 'object')
    throw new NeedleError('INVALID_ARGUMENT', 'A tool inputSchema must describe an object.');
  if (options.execute !== undefined && typeof options.execute !== 'function')
    throw new NeedleError('INVALID_ARGUMENT', 'execute must be a function.');
  const definition = Object.freeze({
    inputSchema: schema,
    ...(options.description === undefined ? {} : { description: options.description }),
    ...(options.triggers === undefined ? {} : { triggers: options.triggers }),
    ...(options.execute === undefined ? {} : { execute: options.execute }),
  });
  if (validate) validators.set(definition, validate);
  return definition;
}

export type ToolCall<Tools extends ToolCollection = ToolCollection> = Tools extends ToolSet
  ? {
      [Name in keyof Tools & string]: {
        toolName: Name;
        input: Tools[Name] extends Tool<infer Input> ? Input : unknown;
      };
    }[keyof Tools & string]
  : { toolName: string; input: Record<string, JsonValue> };

export function normalizeTools(tools: ToolCollection): readonly ToolDefinition[] {
  if (Array.isArray(tools)) return tools;
  if (!tools || typeof tools !== 'object')
    throw new NeedleError(
      'INVALID_ARGUMENT',
      'tools must be a named tool object or an array of schemas.',
    );
  return Object.entries(tools).map(([name, value]: [string, Tool]) => {
    if (!value || typeof value !== 'object' || !value.inputSchema) {
      throw new NeedleError(
        'INVALID_ARGUMENT',
        `Tool ${name} needs inputSchema. Use tool({ inputSchema, description }).`,
      );
    }
    return {
      name,
      parameters: value.inputSchema,
      ...(value.description === undefined ? {} : { description: value.description }),
      ...(value.triggers === undefined ? {} : { triggers: value.triggers }),
    };
  });
}
