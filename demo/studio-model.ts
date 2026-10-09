import { type ToolCall, tool } from 'cactus-needle/browser';

export const trackNames = ['kick', 'snare', 'hats', 'bass'] as const;
export type TrackName = (typeof trackNames)[number];

const numeric = String.raw`(?=[\s\S]*\d)`;

export const studioTools = {
  set_tempo: tool({
    description: 'Set the tempo of the beat in beats per minute.',
    triggers: [numeric + String.raw`[\s\S]*\b(tempo|bpm)\b`],
    inputSchema: {
      type: 'object',
      properties: { bpm: { type: 'integer', minimum: 40, maximum: 200 } },
      required: ['bpm'],
      additionalProperties: false,
    },
  }),
  set_pattern: tool({
    description: 'Replace the rhythm of a track with the listed steps, numbered 1 to 16.',
    triggers: [numeric + String.raw`[\s\S]*\b(pattern|steps)\b`],
    inputSchema: {
      type: 'object',
      properties: {
        track: { type: 'string', enum: trackNames },
        steps: {
          type: 'array',
          items: { type: 'integer', minimum: 1, maximum: 16 },
          maxItems: 16,
          uniqueItems: true,
        },
      },
      required: ['track', 'steps'],
      additionalProperties: false,
    },
  }),
  set_volume: tool({
    description: 'Set the volume of a track to a percentage.',
    triggers: [numeric + String.raw`[\s\S]*\bvolume\b`],
    inputSchema: {
      type: 'object',
      properties: {
        track: { type: 'string', enum: trackNames },
        volume: { type: 'integer', minimum: 0, maximum: 100 },
      },
      required: ['track', 'volume'],
      additionalProperties: false,
    },
  }),
  set_playback: tool({
    description: 'Start or stop playing the beat.',
    triggers: [String.raw`\b(start|stop|pause|resume|play)\b`],
    inputSchema: {
      type: 'object',
      properties: { playing: { type: 'boolean' } },
      required: ['playing'],
      additionalProperties: false,
    },
  }),
  adjust_tempo: tool({
    description: 'Make the tempo faster or slower. Speed it up or slow it down.',
    triggers: [String.raw`\b(faster|slower|speed|slow)\b`],
    inputSchema: {
      type: 'object',
      properties: { direction: { type: 'string', enum: ['increase', 'decrease'] } },
      required: ['direction'],
      additionalProperties: false,
    },
  }),
  adjust_volume: tool({
    description:
      'Turn a track up or down. More bass makes the bass louder; less bass makes it quieter. Raise or lower the volume.',
    triggers: [
      String.raw`\b(louder|quieter)\b`,
      String.raw`\b(more|less|up|down)\b[\s\S]*\b(bass|hats|snare|kick|volume)\b`,
      String.raw`\b(bass|hats|snare|kick|volume)\b[\s\S]*\b(up|down)\b`,
    ],
    inputSchema: {
      type: 'object',
      properties: {
        track: { type: 'string', enum: ['all', ...trackNames], default: 'all' },
        direction: { type: 'string', enum: ['increase', 'decrease'] },
      },
      required: ['track', 'direction'],
      additionalProperties: false,
    },
  }),
};

export interface Beat {
  bpm: number;
  playing: boolean;
  tracks: Record<TrackName, { steps: number[]; volume: number }>;
}

export function initialBeat(): Beat {
  return {
    bpm: 120,
    playing: false,
    tracks: {
      kick: { steps: [1, 9], volume: 80 },
      snare: { steps: [5, 13], volume: 65 },
      hats: { steps: [3, 7, 11, 15], volume: 45 },
      bass: { steps: [1, 7, 9, 15], volume: 65 },
    },
  };
}

function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Expected a whole number from ${min} to ${max}.`);
  }
  return value;
}

function track(value: unknown): TrackName {
  if (!trackNames.some((name) => name === value)) throw new Error('Unknown track.');
  return value as TrackName;
}

function direction(value: unknown): number {
  if (value === 'increase') return 1;
  if (value === 'decrease') return -1;
  throw new Error('Unknown adjustment direction.');
}

// Validate the entire prediction before committing any changes, including audio playback.
export function applyStudioCalls(beat: Beat, calls: readonly ToolCall[]): Beat {
  const next = structuredClone(beat);
  for (const { toolName, input } of calls) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('Invalid tool arguments.');
    }
    const args = input as Record<string, unknown>;
    switch (toolName) {
      case 'adjust_tempo':
        next.bpm = Math.max(40, Math.min(200, next.bpm + direction(args.direction) * 12));
        break;
      case 'adjust_volume': {
        const names =
          args.track === undefined || args.track === 'all' ? trackNames : [track(args.track)];
        const amount = direction(args.direction) * 15;
        for (const name of names) {
          next.tracks[name].volume = Math.max(0, Math.min(100, next.tracks[name].volume + amount));
        }
        break;
      }
      case 'set_tempo':
        next.bpm = integer(args.bpm, 40, 200);
        break;
      case 'set_pattern': {
        const name = track(args.track);
        if (!Array.isArray(args.steps) || args.steps.length > 16) {
          throw new Error('Expected up to 16 steps.');
        }
        const steps = args.steps.map((step: unknown) => integer(step, 1, 16));
        if (new Set(steps).size !== steps.length) throw new Error('Steps must be unique.');
        next.tracks[name].steps = steps;
        break;
      }
      case 'set_volume':
        next.tracks[track(args.track)].volume = integer(args.volume, 0, 100);
        break;
      case 'set_playback':
        if (typeof args.playing !== 'boolean') throw new Error('Invalid playback state.');
        next.playing = args.playing;
        break;
      default:
        throw new Error('Unknown studio tool.');
    }
  }
  // Audition musical edits immediately; explicit playback commands take precedence.
  if (calls.length && !calls.some((call) => call.toolName === 'set_playback')) next.playing = true;
  return next;
}
