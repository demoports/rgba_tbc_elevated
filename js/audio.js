import { EXIT_SAMPLE, SAMPLE_RATE, TOTAL_SAMPLES } from './synth-worker.js';

export { EXIT_SAMPLE, SAMPLE_RATE, TOTAL_SAMPLES };

export const AUDIO_DURATION = EXIT_SAMPLE / SAMPLE_RATE;

const DEFAULT_START_LEAD = 0.05;
const COPY_CHUNK_FRAMES = 262_144;

function nextTask() {
  // A timer yields to painting without making preparation depend on a visible
  // tab's requestAnimationFrame cadence.
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function clampSample(sample) {
  if (!Number.isFinite(sample)) return 0;
  return Math.max(0, Math.min(EXIT_SAMPLE, Math.floor(sample)));
}

/**
 * One-shot Web Audio transport for the original Elevated soundtrack.
 *
 * `prepare()` renders in a module worker. `start()` is safe to call directly
 * from a user gesture even if rendering is not finished: it resumes the audio
 * context first, preserving browser autoplay permission, then waits for PCM.
 */
export class ElevatedAudio {
  constructor({
    workerUrl = new URL('./synth-worker.js', import.meta.url),
    onProgress = null,
    onStateChange = null,
    startLead = DEFAULT_START_LEAD,
  } = {}) {
    this.workerUrl = workerUrl;
    this.onProgress = onProgress;
    this.onStateChange = onStateChange;
    this.startLead = Math.max(0, startLead);

    this.state = 'idle';
    this.context = null;
    this.buffer = null;
    this.source = null;
    this.renderMs = 0;

    this._pcm = null;
    this._worker = null;
    this._preparePromise = null;
    this._cancelPrepare = null;
    this._prepareGeneration = 0;
    this._bufferPromise = null;
    this._startContextTime = 0;
    this._startOffset = 0;
    this._heldSample = 0;
    this._sourceGeneration = 0;
    this._disposed = false;
  }

  get ready() {
    return this.buffer !== null || this._pcm !== null;
  }

  get playing() {
    return this.state === 'playing';
  }

  get paused() {
    return this.state === 'paused';
  }

  get samplePosition() {
    return this.getSamplePosition();
  }

  get currentTime() {
    return this.getSamplePosition() / SAMPLE_RATE;
  }

  get duration() {
    return AUDIO_DURATION;
  }

  _setState(state, detail = {}) {
    this.state = state;
    this.onStateChange?.({ state, audio: this, ...detail });
  }

  _progress(update) {
    this.onProgress?.({ audio: this, ...update });
  }

  prepare() {
    if (this._disposed) return Promise.reject(new Error('ElevatedAudio has been disposed.'));
    if (this.ready) return Promise.resolve(this);
    if (this._preparePromise) return this._preparePromise;
    if (typeof Worker !== 'function') {
      return Promise.reject(new Error('This browser does not support module workers.'));
    }

    this._setState('rendering');
    this._progress({ phase: 'synth', stage: 'initializing', progress: 0 });

    let worker;
    try {
      worker = new Worker(this.workerUrl, { type: 'module', name: 'elevated-synth' });
    } catch (error) {
      const reason = error instanceof Error ? error : new Error(String(error));
      this._setState('error', { error: reason });
      return Promise.reject(reason);
    }

    const generation = ++this._prepareGeneration;
    this._worker = worker;

    this._preparePromise = new Promise((resolve, reject) => {
      let settled = false;

      const fail = (error) => {
        if (settled) return;
        settled = true;
        worker.terminate();
        if (this._worker === worker) this._worker = null;
        if (this._prepareGeneration === generation) {
          this._preparePromise = null;
          this._cancelPrepare = null;
        }
        const reason = error instanceof Error ? error : new Error(String(error));
        if (!this._disposed) this._setState('error', { error: reason });
        reject(reason);
      };
      this._cancelPrepare = fail;

      worker.addEventListener('error', (event) => {
        fail(event.error ?? new Error(event.message || 'The soundtrack worker failed.'));
      });

      worker.addEventListener('message', async (event) => {
        const message = event.data;
        if (settled) return;
        if (this._disposed || this._prepareGeneration !== generation) {
          fail(new Error('Soundtrack preparation was cancelled.'));
          return;
        }
        if (message?.type === 'progress') {
          this._progress({ phase: 'synth', ...message });
          return;
        }
        if (message?.type === 'error') {
          fail(new Error(message.message || 'The soundtrack worker failed.'));
          return;
        }
        if (message?.type !== 'complete') return;

        worker.terminate();
        if (this._worker === worker) this._worker = null;

        try {
          if (
            message.sampleRate !== SAMPLE_RATE ||
            message.totalSamples !== TOTAL_SAMPLES ||
            message.exitSample !== EXIT_SAMPLE
          ) {
            throw new Error('The soundtrack worker returned incompatible PCM metadata.');
          }
          this._pcm = new Int16Array(message.pcm, 0, TOTAL_SAMPLES * 2);
          this.renderMs = message.renderMs;

          // AudioBuffer is context-independent. Constructing it here keeps the
          // eventual user-gesture start path short; older implementations can
          // fall back to context.createBuffer() inside start().
          if (typeof AudioBuffer === 'function') await this._ensureBuffer();

          if (this._disposed || this._prepareGeneration !== generation) {
            throw new Error('Soundtrack preparation was cancelled.');
          }

          settled = true;
          this._preparePromise = null;
          this._cancelPrepare = null;
          this._setState('ready', { renderMs: this.renderMs });
          this._progress({ phase: 'audio', stage: 'ready', progress: 1 });
          resolve(this);
        } catch (error) {
          fail(error);
        }
      });

      worker.postMessage({ type: 'render' });
    });

    return this._preparePromise;
  }

  async _ensureContext() {
    if (this.context && this.context.state !== 'closed') return this.context;

    const AudioContextClass = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    if (!AudioContextClass) throw new Error('Web Audio is not available in this browser.');

    try {
      this.context = new AudioContextClass({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
    } catch {
      // A 44.1 kHz context is preferable, but the source AudioBuffer still
      // declares 44.1 kHz and Web Audio will resample it when necessary.
      this.context = new AudioContextClass({ latencyHint: 'interactive' });
    }
    return this.context;
  }

  async _ensureBuffer() {
    if (this._disposed) throw new Error('ElevatedAudio has been disposed.');
    if (this.buffer) return this.buffer;
    if (this._bufferPromise) return this._bufferPromise;
    if (!this._pcm) throw new Error('Soundtrack PCM has not been rendered yet.');

    this._bufferPromise = (async () => {
      let buffer;
      if (typeof AudioBuffer === 'function') {
        buffer = new AudioBuffer({
          numberOfChannels: 2,
          length: EXIT_SAMPLE,
          sampleRate: SAMPLE_RATE,
        });
      } else {
        const context = await this._ensureContext();
        buffer = context.createBuffer(2, EXIT_SAMPLE, SAMPLE_RATE);
      }

      const left = buffer.getChannelData(0);
      const right = buffer.getChannelData(1);
      for (let start = 0; start < EXIT_SAMPLE; start += COPY_CHUNK_FRAMES) {
        if (this._disposed) throw new Error('ElevatedAudio has been disposed.');
        const end = Math.min(EXIT_SAMPLE, start + COPY_CHUNK_FRAMES);
        for (let frame = start; frame < end; frame++) {
          left[frame] = this._pcm[frame * 2] / 32_768;
          right[frame] = this._pcm[frame * 2 + 1] / 32_768;
        }
        this._progress({
          phase: 'audio',
          stage: 'uploading PCM',
          progress: end / EXIT_SAMPLE,
        });
        if (end < EXIT_SAMPLE) await nextTask();
      }

      if (this._disposed) throw new Error('ElevatedAudio has been disposed.');
      this.buffer = buffer;
      this._pcm = null;
      this._bufferPromise = null;
      return buffer;
    })().catch((error) => {
      this._bufferPromise = null;
      throw error;
    });

    return this._bufferPromise;
  }

  async start(offsetSamples = 0) {
    if (this._disposed) throw new Error('ElevatedAudio has been disposed.');
    const offset = clampSample(offsetSamples);

    // Resume synchronously near the beginning of the user-gesture call. This
    // matters when start() must await a still-running synth worker.
    const context = await this._ensureContext();
    if (context.state === 'suspended') await context.resume();
    if (this._disposed) throw new Error('ElevatedAudio has been disposed.');

    await this.prepare();
    const buffer = await this._ensureBuffer();
    if (this._disposed) throw new Error('ElevatedAudio has been disposed.');
    if (context.state === 'suspended') await context.resume();
    if (this._disposed) throw new Error('ElevatedAudio has been disposed.');

    this._stopSource(false);
    this._heldSample = offset;
    this._startOffset = offset;

    if (offset >= EXIT_SAMPLE) {
      this._setState('ended');
      return this;
    }

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.loop = false;
    source.connect(context.destination);

    const generation = ++this._sourceGeneration;
    const startTime = context.currentTime + this.startLead;
    this._startContextTime = startTime;
    this.source = source;

    source.addEventListener('ended', () => {
      if (this.source !== source || this._sourceGeneration !== generation) return;
      this.source = null;
      this._heldSample = EXIT_SAMPLE;
      this._setState('ended');
    });

    source.start(startTime, offset / SAMPLE_RATE);
    // The original process exits at 0x910000 even though its generated buffer
    // extends to 0x920000. Stop on that same composition sample.
    source.stop(startTime + (EXIT_SAMPLE - offset) / SAMPLE_RATE);
    this._setState('playing', { offsetSamples: offset, startTime });
    return this;
  }

  _stopSource(invalidate = true) {
    const source = this.source;
    if (invalidate) this._sourceGeneration++;
    this.source = null;
    if (!source) return;
    try {
      source.stop();
    } catch {
      // A source can already have naturally ended; it is still safe to replay
      // by creating the new AudioBufferSourceNode used by start().
    }
    source.disconnect();
  }

  getSamplePosition() {
    if (this.state === 'paused' || this.state === 'stopped' || this.state === 'ended') {
      return this._heldSample;
    }
    if (this.state !== 'playing' || !this.context) return this._heldSample;

    const context = this.context;
    let outputContextTime = context.currentTime;

    if (context.state === 'running' && typeof context.getOutputTimestamp === 'function') {
      const timestamp = context.getOutputTimestamp();
      if (
        Number.isFinite(timestamp.contextTime) &&
        Number.isFinite(timestamp.performanceTime) &&
        timestamp.performanceTime > 0
      ) {
        // Map performance.now() to the context frame currently reaching the
        // output device. This most closely mirrors waveOutGetPosition().
        outputContextTime =
          timestamp.contextTime + (performance.now() - timestamp.performanceTime) / 1_000;
        outputContextTime = Math.min(outputContextTime, context.currentTime);
      } else {
        outputContextTime = context.currentTime - (context.outputLatency || 0);
      }
    } else if (context.state === 'running') {
      outputContextTime = context.currentTime - (context.outputLatency || 0);
    }

    const elapsed = Math.max(0, outputContextTime - this._startContextTime);
    return clampSample(this._startOffset + Math.floor(elapsed * SAMPLE_RATE));
  }

  async pause() {
    if (this.state !== 'playing' || !this.context) return this;
    this._heldSample = this.getSamplePosition();
    await this.context.suspend();
    if (this._disposed) throw new Error('ElevatedAudio has been disposed.');
    this._setState('paused', { samplePosition: this._heldSample });
    return this;
  }

  async resume() {
    if (this.state !== 'paused' || !this.context) return this;
    await this.context.resume();
    if (this._disposed) throw new Error('ElevatedAudio has been disposed.');
    this._setState('playing', { samplePosition: this._heldSample });
    return this;
  }

  async togglePause() {
    return this.state === 'paused' ? this.resume() : this.pause();
  }

  async seek(samplePosition) {
    const wasPaused = this.state === 'paused';
    await this.start(samplePosition);
    if (wasPaused) await this.pause();
    return this;
  }

  stop() {
    if (this._disposed) return this;
    if (this.state === 'playing') this._heldSample = this.getSamplePosition();
    this._stopSource();
    this._setState('stopped', { samplePosition: this._heldSample });
    return this;
  }

  async dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._prepareGeneration++;
    this._cancelPrepare?.(new Error('Soundtrack preparation was cancelled.'));
    this._cancelPrepare = null;
    this._worker?.terminate();
    this._worker = null;
    this._preparePromise = null;
    this._stopSource();
    const context = this.context;
    this.context = null;
    this.buffer = null;
    this._pcm = null;
    this._bufferPromise = null;
    this._setState('disposed');
    if (context && context.state !== 'closed') await context.close();
  }
}

export function createElevatedAudio(options) {
  return new ElevatedAudio(options);
}
