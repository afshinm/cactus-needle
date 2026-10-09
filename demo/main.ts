import { createNeedle, type Needle, NeedleError } from 'cactus-needle/browser';
import { element } from './dom.ts';
import { createLights } from './lights.ts';
import { createStudio } from './studio.ts';
import './style.css';

const demos = { studio: createStudio(), lights: createLights() };
let selected: keyof typeof demos = 'studio';
const form = element<HTMLFormElement>('#prompt-form');
const prompt = element<HTMLTextAreaElement>('#prompt');
const run = element<HTMLButtonElement>('#run');
const status = element<HTMLParagraphElement>('#status');
const result = element<HTMLDivElement>('#result');
const calls = element<HTMLElement>('#calls');
const callLabel = element('#call-label');
const viewTools = element<HTMLButtonElement>('#view-tools');
const examples = element('#examples');
const tabs = document.querySelectorAll<HTMLButtonElement>('[data-demo]');
let needle: Needle | undefined;
let active: AbortController | undefined;

function message(text: string, error = false): void {
  status.textContent = text;
  status.dataset.error = String(error);
}

function errorMessage(error: unknown): string {
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

async function generate(): Promise<void> {
  if (active) {
    active.abort();
    return;
  }
  const input = prompt.value.trim();
  if (!input) return;
  const demo = demos[selected];
  const controller = new AbortController();
  active = controller;
  prompt.readOnly = true;
  run.disabled = false;
  run.textContent = 'Cancel';
  for (const button of examples.querySelectorAll('button')) button.disabled = true;
  for (const tab of tabs) tab.disabled = true;
  result.hidden = true;
  viewTools.hidden = true;
  viewTools.setAttribute('aria-expanded', 'false');
  form.setAttribute('aria-busy', 'true');

  try {
    await demo.prepare?.();
    controller.signal.throwIfAborted();
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
    const elapsed = Math.round(performance.now() - start);
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
      await needle?.close();
      needle = undefined;
    }
    message(
      controller.signal.aborted ? 'Cancelled.' : errorMessage(error),
      !controller.signal.aborted,
    );
  } finally {
    active = undefined;
    prompt.readOnly = false;
    run.textContent = 'Run';
    run.disabled = !prompt.value.trim();
    for (const button of examples.querySelectorAll('button')) button.disabled = false;
    for (const tab of tabs) tab.disabled = false;
    form.setAttribute('aria-busy', 'false');
  }
}

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
  needle = undefined;
});
selectDemo(location.hash === '#lights' ? 'lights' : 'studio');
