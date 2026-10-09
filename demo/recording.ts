export interface Recording {
  stop(): void;
  result: Promise<Float32Array>;
  startedAt: number;
  level(): number;
}

/** The browser captures audio; Whistle alone handles speech recognition. */
export async function startRecording(signal: AbortSignal): Promise<Recording> {
  signal.throwIfAborted();
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined')
    throw new Error('Voice input needs a browser with microphone recording support.');
  // Resume during the click gesture, before waiting for microphone permission.
  const context = new AudioContext();
  void context.resume().catch(() => {});
  const requested = navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });
  const release = (stream: MediaStream) => {
    for (const track of stream.getTracks()) track.stop();
  };
  // Permission prompts cannot be cancelled. Release a late grant after cancellation.
  void requested.then(
    (stream) => {
      if (signal.aborted) release(stream);
    },
    () => {},
  );
  let abortPermission!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abortPermission = () => reject(signal.reason);
    signal.addEventListener('abort', abortPermission, { once: true });
  });
  let stream: MediaStream;
  try {
    stream = await Promise.race([requested, cancelled]);
  } catch (error) {
    void context.close();
    throw error;
  } finally {
    signal.removeEventListener('abort', abortPermission);
  }
  if (signal.aborted) {
    release(stream);
    void context.close();
    signal.throwIfAborted();
  }
  let recorder: MediaRecorder;
  let source: MediaStreamAudioSourceNode;
  let analyser: AnalyserNode;
  try {
    recorder = new MediaRecorder(stream);
    source = context.createMediaStreamSource(stream);
    analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
  } catch (error) {
    release(stream);
    void context.close();
    throw error;
  }
  const samples = new Float32Array(analyser.fftSize);
  const chunks: Blob[] = [];
  let timer: ReturnType<typeof setTimeout>;
  let activity: ReturnType<typeof setInterval>;
  let level = 0;
  let released = false;
  let failed = false;
  const cleanup = () => {
    clearTimeout(timer);
    clearInterval(activity);
    if (released) return;
    released = true;
    release(stream);
    source.disconnect();
    void context.close();
  };
  const stop = () => {
    if (recorder.state !== 'inactive') recorder.stop();
    cleanup();
  };
  const startedAt = performance.now();
  let noiseFloor = 0.003;
  let speechStarted: number | undefined;
  let heardSpeech = false;
  let lastSpeech = startedAt;
  const detectPause = () => {
    if (context.state !== 'running') return;
    analyser.getFloatTimeDomainData(samples);
    level = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
    const now = performance.now();
    if (level > Math.max(0.008, noiseFloor * 3)) {
      speechStarted ??= now;
      // A click or bump should not arm the silence timeout.
      if (now - speechStarted >= 150) heardSpeech = true;
      lastSpeech = now;
    } else {
      speechStarted = undefined;
      noiseFloor = noiseFloor * 0.95 + level * 0.05;
      if (heardSpeech && now - lastSpeech >= 1600) stop();
    }
  };
  const result = new Promise<Float32Array>((resolve, reject) => {
    const abort = () => {
      stop();
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    recorder.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data);
    };
    recorder.onerror = () => {
      failed = true;
      stop();
      reject(new Error('Microphone recording failed. Try again.'));
    };
    recorder.onstop = async () => {
      cleanup();
      signal.removeEventListener('abort', abort);
      if (failed) return;
      try {
        signal.throwIfAborted();
        const encoded = await new Blob(chunks, { type: recorder.mimeType }).arrayBuffer();
        const decoder = new OfflineAudioContext(1, 1, 16_000);
        const decoded = await decoder.decodeAudioData(encoded);
        signal.throwIfAborted();
        // Include at most 30 seconds even when a background-tab timer fires late.
        const samples = new Float32Array(Math.min(decoded.length, 30 * 16_000));
        for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
          const data = decoded.getChannelData(channel);
          for (let index = 0; index < samples.length; index++)
            samples[index] = (samples[index] ?? 0) + (data[index] ?? 0) / decoded.numberOfChannels;
        }
        resolve(samples);
      } catch (error) {
        reject(error);
      }
    };
    try {
      recorder.start();
      timer = setTimeout(stop, 30_000);
      activity = setInterval(detectPause, 50);
    } catch (error) {
      signal.removeEventListener('abort', abort);
      cleanup();
      reject(error);
    }
  });
  return {
    stop,
    result,
    startedAt,
    level() {
      return released ? 0 : level;
    },
  };
}
