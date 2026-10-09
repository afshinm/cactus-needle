import { element } from './dom.ts';
import { StudioAudio } from './studio-audio.ts';
import {
  applyStudioCalls,
  type Beat,
  initialBeat,
  studioTools,
  trackNames,
} from './studio-model.ts';
import type { Demo } from './types.ts';

export function createStudio(): Demo {
  let beat = initialBeat();
  const tracks = element('#tracks');
  const play = element<HTMLButtonElement>('#play');
  const tempo = element<HTMLInputElement>('#tempo');
  const audioStatus = element('#audio-status');

  for (const name of trackNames) {
    const title = name.charAt(0).toUpperCase() + name.slice(1);
    const row = document.createElement('div');
    row.className =
      'track grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-2 sm:grid-cols-[64px_1fr_94px]';
    row.dataset.track = name;
    row.innerHTML = `
      <span class="track-name text-[17px]">${title}</span>
      <div class="steps col-span-2 row-start-2 grid grid-cols-8 gap-1.5 sm:col-span-1 sm:col-start-2 sm:row-start-1 sm:grid-cols-16" role="group" aria-label="${title} pattern"></div>
      <label class="col-start-2 row-start-1 flex items-center gap-2 sm:col-start-3">
        <span class="sr-only">${title} volume</span>
        <input class="w-16 accent-black" type="range" min="0" max="100" step="1" value="${beat.tracks[name].volume}" />
        <output class="w-6 text-right text-sm text-gray-500 tabular-nums">${beat.tracks[name].volume}</output>
      </label>`;
    const steps = row.querySelector('.steps');
    for (let step = 1; step <= 16; step++) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'step h-10 rounded-md text-xs tabular-nums sm:h-11';
      button.dataset.step = String(step);
      button.setAttribute('aria-label', `${title} step ${step}`);
      button.addEventListener('click', () => {
        const next = structuredClone(beat);
        const pattern = next.tracks[name].steps;
        next.tracks[name].steps = pattern.includes(step)
          ? pattern.filter((value) => value !== step)
          : [...pattern, step].sort((a, b) => a - b);
        commit(next);
      });
      button.textContent = String(step);
      steps?.append(button);
    }
    const volume = row.querySelector('input');
    volume?.addEventListener('change', () => {
      const next = structuredClone(beat);
      next.tracks[name].volume = Number(volume.value);
      commit(next);
    });
    tracks.append(row);
  }

  const stepButtons = tracks.querySelectorAll<HTMLButtonElement>('[data-step]');
  const audio = new StudioAudio(
    () => beat,
    (step) => {
      for (const button of stepButtons) {
        button.dataset.current = String(Number(button.dataset.step) === step + 1);
      }
    },
  );

  function render(): void {
    tempo.value = String(beat.bpm);
    play.setAttribute('aria-pressed', String(beat.playing));
    element('#play-label').textContent = beat.playing ? 'Stop' : 'Play';
    for (const name of trackNames) {
      const row = element(`[data-track="${name}"]`);
      row.dataset.silent = String(beat.tracks[name].volume === 0);
      const volume = row.querySelector('input');
      const output = row.querySelector('output');
      if (volume) volume.value = String(beat.tracks[name].volume);
      if (output) output.value = String(beat.tracks[name].volume);
      for (const button of row.querySelectorAll('[data-step]')) {
        button.setAttribute(
          'aria-pressed',
          String(beat.tracks[name].steps.includes(Number(button.getAttribute('data-step')))),
        );
      }
    }
  }

  function commit(next: Beat): void {
    const previous = beat;
    beat = next;
    try {
      if (beat.playing) audio.start();
      else audio.stop();
    } catch (error) {
      beat = previous;
      throw error;
    }
    render();
  }

  async function enableAudio(): Promise<void> {
    await audio.unlock();
    audioStatus.textContent = '';
  }

  play.addEventListener('click', async () => {
    play.disabled = true;
    try {
      await enableAudio();
      commit({ ...beat, playing: !beat.playing });
    } catch {
      audioStatus.textContent = 'Could not start audio. Try pressing Play again.';
    } finally {
      play.disabled = false;
    }
  });
  tempo.addEventListener('change', () => {
    if (tempo.checkValidity()) commit({ ...beat, bpm: Number(tempo.value) });
    else render();
  });
  function stop(): void {
    beat = { ...beat, playing: false };
    audio.stop();
    render();
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stop();
  });
  window.addEventListener('pagehide', () => {
    stop();
    void audio.close();
  });
  render();

  return {
    tools: studioTools,
    label: 'Tell the studio what to change',
    hint: 'Try a tempo, a track volume, or a pattern with steps 1–16.',
    examples: [
      {
        label: 'Build a dance beat',
        prompt:
          'Bring the tempo to 128 bpm, put the kick on steps 1, 5, 9, 13, and set the bass volume to 80.',
      },
      {
        label: 'Slow it down',
        prompt:
          'Slow it down to 90 bpm, lower the hats volume to 20, and bring the bass volume to 70.',
      },
      {
        label: 'Louder bass, quieter hats',
        prompt: 'Make the bass louder and the hats quieter.',
      },
      {
        label: 'Change the drums',
        prompt: 'Set the kick pattern to steps 1, 7, 9, 11 and the snare pattern to steps 5, 13.',
      },
      {
        label: 'More energy',
        prompt: 'Set the tempo to 140, the snare volume to 80, and the hats volume to 60.',
      },
    ],
    prepare: enableAudio,
    apply: (calls) => commit(applyStudioCalls(beat, calls)),
    deactivate: stop,
  };
}
