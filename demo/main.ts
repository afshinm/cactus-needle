import {
  createNeedle,
  createWhistle,
  type Needle,
  NeedleError,
  type Whistle,
} from 'cactus-needle/browser';
import { element } from './dom.ts';
import { createLights } from './lights.ts';
import { type Recording, startRecording } from './recording.ts';
import { createStudio } from './studio.ts';
import './style.css';

const demos = { studio: createStudio(), lights: createLights() };
let selected: keyof typeof demos = 'studio';
const form = element<HTMLFormElement>('#prompt-form');
const prompt = element<HTMLTextAreaElement>('#prompt');
const run = element<HTMLButtonElement>('#run');
const microphone = element<HTMLButtonElement>('#microphone');
const recordingFeedback = element('#recording-feedback');
const recordingSignal = element<HTMLCanvasElement>('#recording-signal');
const recordingTime = element('#recording-time');
const status = element<HTMLParagraphElement>('#status');
const result = element<HTMLDivElement>('#result');
const calls = element<HTMLElement>('#calls');
const callLabel = element('#call-label');
const viewTools = element<HTMLButtonElement>('#view-tools');
const examples = element('#examples');
const tabs = document.querySelectorAll<HTMLButtonElement>('[data-demo]');
let needle: Needle | undefined;
let whistle: Whistle | undefined;
let recording: Recording | undefined;
let active: AbortController | undefined;
let stopFeedback: (() => void) | undefined;

function showRecording(capture: Recording): () => void {
  const context = recordingSignal.getContext('2d');
  const levels: number[] = [];
  const interval = matchMedia('(prefers-reduced-motion: reduce)').matches ? 150 : 50;
  let previous = 0;
  let frame = 0;
  recordingFeedback.hidden = false;
  prompt.style.visibility = 'hidden';
  const draw = (now: number) => {
    frame = requestAnimationFrame(draw);
    if (now - previous < interval) return;
    previous = now;
    const seconds = Math.min(30, Math.floor((now - capture.startedAt) / 1000));
    recordingTime.textContent = `0:${String(seconds).padStart(2, '0')}`;
    if (!context) return;
    const width = recordingSignal.clientWidth;
    const height = recordingSignal.clientHeight;
    const scale = window.devicePixelRatio || 1;
    if (
      recordingSignal.width !== Math.round(width * scale) ||
      recordingSignal.height !== Math.round(height * scale)
    ) {
      recordingSignal.width = Math.round(width * scale);
      recordingSignal.height = Math.round(height * scale);
    }
    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.clearRect(0, 0, width, height);
    levels.push(Math.min(1, capture.level() * 6));
    const count = Math.floor(width / 5);
    levels.splice(0, Math.max(0, levels.length - count));
    for (let index = 0; index < count; index++) {
      const level = levels[index - (count - levels.length)] ?? 0;
      const bar = Math.max(2, level * (height - 4));
      context.fillStyle = level > 0.025 ? '#27272a' : '#d1d5db';
      context.beginPath();
      context.roundRect(index * 5, (height - bar) / 2, 2, bar, 1);
      context.fill();
    }
  };
  draw(performance.now());
  return () => {
    cancelAnimationFrame(frame);
    recordingFeedback.hidden = true;
    prompt.style.visibility = '';
  };
}

function message(text: string, error = false): void {
  status.textContent = text;
  status.dataset.error = String(error);
}

function errorMessage(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError')
      return 'Allow microphone access in your browser, then try again.';
    if (error.name === 'NotFoundError') return 'No microphone found. Connect one and try again.';
    if (error.name === 'NotReadableError')
      return 'The microphone is busy. Close other recording apps and try again.';
    if (error.name === 'EncodingError') return 'Could not read that recording. Try again.';
  }
  if (error instanceof NeedleError) {
    if (error.code === 'DOWNLOAD_FAILED')
      return 'Could not download the model. Check your connection and try again.';
    if (error.code === 'INTEGRITY_ERROR')
      return 'The downloaded model could not be verified. Please try again.';
    if (error.code === 'UNSUPPORTED_ENVIRONMENT')
      return 'This browser cannot run the model. Try a current version of Chrome or Edge.';
  }
  return `Could not apply that request. ${demos[selected].hint}`;
}

function selectDemo(name: keyof typeof demos): void {
  if (active) return;
  demos[selected].deactivate?.();
  selected = name;
  const demo = demos[name];
  for (const tab of tabs) tab.setAttribute('aria-pressed', String(tab.dataset.demo === name));
  element('#panel-studio').hidden = name !== 'studio';
  element('#panel-lights').hidden = name !== 'lights';
  element('#prompt-label').textContent = demo.label;
  prompt.placeholder = `${demo.label}…`;
  prompt.value = demo.examples[0]?.prompt ?? '';
  prompt.rows = name === 'studio' ? 2 : 1;
  run.disabled = !prompt.value;
  result.hidden = true;
  viewTools.hidden = true;
  viewTools.setAttribute('aria-expanded', 'false');
  message(needle ? 'Ready.' : 'Runs in your browser. First use downloads 35 MB.');
  examples.replaceChildren();
  for (const example of demo.examples) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'example-button';
    button.textContent = example.label;
    button.title = example.prompt;
    button.addEventListener('click', () => {
      prompt.value = example.prompt;
      void generate();
    });
    examples.append(button);
  }
}

async function generate(voice = false): Promise<void> {
  if (active) {
    active.abort();
    return;
  }
  let input = prompt.value.trim();
  if (!input && !voice) return;
  const demo = demos[selected];
  const controller = new AbortController();
  active = controller;
  prompt.readOnly = true;
  run.disabled = false;
  run.textContent = 'Cancel';
  microphone.disabled = true;
  for (const button of examples.querySelectorAll('button')) button.disabled = true;
  for (const tab of tabs) tab.disabled = true;
  result.hidden = true;
  viewTools.hidden = true;
  viewTools.setAttribute('aria-expanded', 'false');
  form.setAttribute('aria-busy', 'true');
  let modelInUse: 'needle' | 'whistle' | undefined;

  try {
    await demo.prepare?.();
    controller.signal.throwIfAborted();
    let speechTime = 0;
    if (voice) {
      demo.deactivate?.();
      message('Allow the microphone to record a command.');
      recording = await startRecording(controller.signal);
      stopFeedback = showRecording(recording);
      microphone.disabled = false;
      microphone.dataset.recording = 'true';
      microphone.setAttribute('aria-pressed', 'true');
      microphone.setAttribute('aria-label', 'Stop recording');
      microphone.title = 'Stop recording';
      message('Listening… Stops after a pause, or press stop.');
      const audio = await recording.result;
      stopFeedback();
      stopFeedback = undefined;
      recording = undefined;
      microphone.disabled = true;
      microphone.dataset.recording = 'false';
      microphone.setAttribute('aria-pressed', 'false');
      controller.signal.throwIfAborted();
      modelInUse = 'whistle';
      if (!whistle) {
        message('Loading speech model…');
        whistle = await createWhistle({
          abortSignal: controller.signal,
          onDownloadProgress: ({ percentage }) =>
            message(
              percentage === 100
                ? 'Starting speech model…'
                : `Downloading speech model… ${Math.round(percentage ?? 0)}%`,
            ),
        });
      }
      message('Transcribing…');
      const start = performance.now();
      const transcript = await whistle.transcribe(audio, { abortSignal: controller.signal });
      modelInUse = undefined;
      speechTime = performance.now() - start;
      input = transcript.text.trim();
      if (!input) {
        message('No speech heard. Try again.');
        return;
      }
      prompt.value = input;
    }
    modelInUse = 'needle';
    if (!needle) {
      message('Loading model…');
      needle = await createNeedle({
        stateless: true,
        abortSignal: controller.signal,
        onDownloadProgress: ({ percentage }) => {
          message(
            percentage === 100
              ? 'Starting model…'
              : `Downloading model… ${Math.round(percentage ?? 0)}%`,
          );
        },
      });
    }
    message('Running…');
    const start = performance.now();
    const response = await needle.generate({
      prompt: input,
      tools: demo.tools,
      abortSignal: controller.signal,
    });
    controller.signal.throwIfAborted();
    modelInUse = undefined;
    const elapsed = Math.round(performance.now() - start + speechTime);
    const { toolCalls, suppressedToolCalls } = response;
    // Suppressed predictions are visible for inspection, but are never executed.
    if (toolCalls.length) demo.apply(toolCalls);
    const shown = toolCalls.length ? toolCalls : suppressedToolCalls;
    calls.textContent = shown
      .map(({ toolName, input: args }) => `${toolName}(${JSON.stringify(args)})`)
      .join('\n');
    callLabel.textContent = toolCalls.length ? '' : 'Withheld by the model. No changes made.';
    viewTools.hidden = shown.length === 0;
    message(`${elapsed} ms, ${toolCalls.length} tool ${toolCalls.length === 1 ? 'call' : 'calls'}`);
  } catch (error) {
    if (
      controller.signal.aborted ||
      (error instanceof NeedleError && ['CLOSED', 'WORKER_ERROR'].includes(error.code))
    ) {
      if (modelInUse === 'needle') {
        await needle?.close();
        needle = undefined;
      }
      if (modelInUse === 'whistle') {
        await whistle?.close();
        whistle = undefined;
      }
    }
    message(
      controller.signal.aborted ? 'Cancelled.' : errorMessage(error),
      !controller.signal.aborted,
    );
  } finally {
    stopFeedback?.();
    stopFeedback = undefined;
    recording?.stop();
    recording = undefined;
    active = undefined;
    microphone.disabled = false;
    microphone.dataset.recording = 'false';
    microphone.setAttribute('aria-pressed', 'false');
    microphone.setAttribute('aria-label', 'Record a command');
    microphone.title = whistle
      ? 'Record a command'
      : 'Record a command. First use downloads 17 MB.';
    prompt.readOnly = false;
    run.textContent = 'Run';
    run.disabled = !prompt.value.trim();
    for (const button of examples.querySelectorAll('button')) button.disabled = false;
    for (const tab of tabs) tab.disabled = false;
    form.setAttribute('aria-busy', 'false');
  }
}

microphone.addEventListener('click', () => {
  if (recording) {
    recording.stop();
    microphone.disabled = true;
  } else if (!active) void generate(true);
});

viewTools.addEventListener('click', () => {
  result.hidden = !result.hidden;
  viewTools.setAttribute('aria-expanded', String(!result.hidden));
});
form.addEventListener('submit', (event) => {
  event.preventDefault();
  void generate();
});
prompt.addEventListener('input', () => {
  run.disabled = !prompt.value.trim();
});
prompt.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    if (!active) form.requestSubmit();
  }
});
for (const tab of tabs) {
  tab.addEventListener('click', () => {
    const name = tab.dataset.demo;
    if (name !== 'studio' && name !== 'lights') return;
    selectDemo(name);
    history.replaceState(null, '', `#${name}`);
  });
}
window.addEventListener('pagehide', () => {
  active?.abort();
  void needle?.close();
  void whistle?.close();
  needle = undefined;
  whistle = undefined;
});
selectDemo(location.hash === '#lights' ? 'lights' : 'studio');
