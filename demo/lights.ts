import { tool } from 'cactus-needle/browser';
import type { Demo } from './types.ts';

export function createLights(): Demo {
  const rooms = document.querySelectorAll<HTMLElement>('[data-room]');
  const roomNames = new Set(['all', ...Array.from(rooms, (room) => room.dataset.room)]);
  return {
    tools: {
      set_lights: tool({
        description: 'Turn the lights in a room on or off. Use all to control every room.',
        inputSchema: {
          type: 'object',
          properties: {
            room: { type: 'string', enum: ['kitchen', 'living room', 'bedroom', 'all'] },
            on: { type: 'boolean' },
          },
          required: ['room', 'on'],
          additionalProperties: false,
        },
      }),
    },
    label: 'Tell the lights what to do',
    hint: 'Try naming a room and whether to turn it on or off.',
    examples: [
      { label: 'Kitchen on', prompt: 'Turn on the kitchen lights' },
      { label: 'Bedroom on', prompt: 'Turn on the bedroom lights' },
      { label: 'All off', prompt: 'Turn off the kitchen, living room, and bedroom lights' },
    ],
    apply(calls) {
      const commands = calls.map(({ toolName, input }) => {
        if (toolName !== 'set_lights' || !input || typeof input !== 'object') {
          throw new Error('Unsupported light command.');
        }
        const command = input as { room: string; on: boolean };
        if (!roomNames.has(command.room) || typeof command.on !== 'boolean') {
          throw new Error('Unsupported light command.');
        }
        return command;
      });
      for (const command of commands) {
        for (const room of rooms) {
          if (command.room !== 'all' && command.room !== room.dataset.room) continue;
          room.dataset.on = String(command.on);
          const state = room.querySelector('.light-state');
          if (state) state.textContent = command.on ? 'On' : 'Off';
        }
      }
    },
  };
}
