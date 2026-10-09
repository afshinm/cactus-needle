export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** JSON Schema is passed to Needle's grammar compiler. Unsupported keywords are engine-dependent. */
export interface JsonSchema {
  readonly type?: string | readonly string[];
  readonly description?: string;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly items?: JsonSchema;
  readonly enum?: readonly JsonValue[];
  readonly [keyword: string]: unknown;
}

export interface ToolSchema {
  readonly name: string;
  readonly description?: string;
  readonly parameters: JsonSchema;
  readonly triggers?: readonly string[];
}

export type ToolDefinition =
  | ToolSchema
  | { readonly type: 'function'; readonly function: ToolSchema };
