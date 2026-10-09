import { type Beat, type TrackName, trackNames } from './studio-model.ts';

// The audio clock schedules ahead; animation frames only paint the playhead.
// https://web.dev/articles/audio-scheduling
function noise(context: BaseAudioContext): AudioBuffer {
  const buffer = context.createBuffer(1, context.sampleRate * 0.3, context.sampleRate);
  const samples = buffer.getChannelData(0);
  for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;
  return buffer;
}

function voice(
  context: BaseAudioContext,
  output: AudioNode,
  noiseBuffer: AudioBuffer,
  track: TrackName,
  time: number,
  step: number,
  volume: number,
): void {
  if (volume === 0) return;
  const envelope = context.createGain();
  const duration = track === 'hats' ? 0.055 : track === 'bass' ? 0.26 : 0.2;
  envelope.gain.setValueAtTime(0, time);
  envelope.gain.linearRampToValueAtTime((volume / 100) * 0.45, time + 0.004);
  envelope.gain.exponentialRampToValueAtTime(0.001, time + duration);
  envelope.gain.linearRampToValueAtTime(0, time + duration + 0.01);
  envelope.connect(output);

  if (track === 'hats' || track === 'snare') {
    const source = context.createBufferSource();
    source.buffer = noiseBuffer;
    const filter = context.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = track === 'hats' ? 7000 : 1400;
    source.connect(filter).connect(envelope);
    source.start(time);
    source.stop(time + duration + 0.02);
    source.onended = () => {
      source.disconnect();
      filter.disconnect();
      envelope.disconnect();
    };
  } else {
    const oscillator = context.createOscillator();
    oscillator.type = track === 'kick' ? 'sine' : 'triangle';
    const filter = context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = track === 'kick' ? 12000 : 1600;
    if (track === 'kick') {
      oscillator.frequency.setValueAtTime(150, time);
      oscillator.frequency.exponentialRampToValueAtTime(45, time + 0.1);
    } else {
      const midi = [36, 43, 46, 43][Math.floor(step / 4)] ?? 36;
      oscillator.frequency.value = 440 * 2 ** ((midi - 69) / 12);
    }
    oscillator.connect(filter).connect(envelope);
    oscillator.start(time);
    oscillator.stop(time + duration + 0.02);
    oscillator.onended = () => {
      oscillator.disconnect();
      filter.disconnect();
      envelope.disconnect();
    };
  }
}

function playStep(
  context: BaseAudioContext,
  output: AudioNode,
  noiseBuffer: AudioBuffer,
  beat: Beat,
  step: number,
  time: number,
): void {
  for (const name of trackNames) {
    const track = beat.tracks[name];
    if (track.steps.includes(step + 1)) {
      voice(context, output, noiseBuffer, name, time, step, track.volume);
    }
  }
}

export class StudioAudio {
  private context: AudioContext | undefined;
  private output: GainNode | undefined;
  private noiseBuffer: AudioBuffer | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private frame = 0;
  private nextTime = 0;
  private nextStep = 0;
  private queue: { step: number; time: number }[] = [];

  constructor(
    private readonly readBeat: () => Beat,
    private readonly paint: (step: number) => void,
  ) {}

  // Call during a click/key event so a later model response can start playback.
  async unlock(): Promise<void> {
    this.context ??= new AudioContext();
    await this.context.resume();
    this.noiseBuffer ??= noise(this.context);
  }

  start(): void {
    if (this.timer !== undefined) return;
    const context = this.context;
    if (context?.state !== 'running') throw new Error('Press Play to enable audio.');
    this.output = context.createGain();
    this.output.gain.value = 0.7;
    this.output.connect(context.destination);
    this.nextStep = 0;
    this.nextTime = context.currentTime + 0.04;
    this.schedule();
    this.timer = setInterval(() => this.schedule(), 25);
    this.draw();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    cancelAnimationFrame(this.frame);
    // Disconnecting the bus also silences notes already scheduled ahead.
    this.output?.disconnect();
    this.output = undefined;
    this.queue = [];
    this.paint(-1);
  }

  async close(): Promise<void> {
    this.stop();
    await this.context?.close();
    this.context = undefined;
    this.noiseBuffer = undefined;
  }

  private schedule(): void {
    const { context, output, noiseBuffer } = this;
    if (!context || !output || !noiseBuffer) return;
    // Never replay a backlog after the browser has throttled a background tab.
    this.nextTime = Math.max(this.nextTime, context.currentTime);
    while (this.nextTime < context.currentTime + 0.1) {
      const beat = this.readBeat();
      playStep(context, output, noiseBuffer, beat, this.nextStep, this.nextTime);
      this.queue.push({ step: this.nextStep, time: this.nextTime });
      this.nextTime += 60 / beat.bpm / 4;
      this.nextStep = (this.nextStep + 1) % 16;
    }
  }

  private draw = (): void => {
    const time = this.context?.currentTime ?? 0;
    let current: number | undefined;
    while (this.queue[0] && this.queue[0].time <= time) current = this.queue.shift()?.step;
    if (current !== undefined) this.paint(current);
    this.frame = requestAnimationFrame(this.draw);
  };
}
