import { machineTree, patternData, sequenceData } from './source-data.js';

// These values are copied from music.h/constants.h. The renderer intentionally
// uses sample counts (not the nominal BPM) because that is what the intro does.
export const SAMPLE_RATE = 44_100;
export const ROW_SAMPLES = 5_210;
export const NUM_ROWS = 114;
export const NUM_CHANNELS = 12;
export const TOTAL_SAMPLES = 0x92_0000;
export const EXIT_SAMPLE = 0x91_0000;

const STEREO_SAMPLES = TOTAL_SAMPLES * 2;
const MAX_DELAY_SAMPLES = 65_536;
const MACHINE_COUNT = 42;
const FINAL_SCALE = 32_767;
const f32 = Math.fround;

// NASM stores these as float32 values. Direct3D 9 device creation occurs before
// generateMusic() and omits D3DCREATE_FPU_PRESERVE, so it also puts x87 in its
// PC24 round-to-nearest mode. The renderer therefore frounds each basic x87
// arithmetic result, not just explicit dword stores. Transcendental operations
// such as FSIN retain their extended result until the following arithmetic op.
const NOTE_FREQ_START = f32(1.749869973e-4);
const NOTE_FREQ_STEP = f32(1.029302237);
const CUTOFF_SCALE = float32FromBits(0x3815_0000);
const ENVELOPE_SCALES = [1, -0.5, 0, -0.5];
const STOP_ENVELOPE_SCALES = [0, 0, 0, 0];

const MACHINE_PARAMETER_BYTES = [72, 12, 32, 12, 8, 8, 12];
const MACHINE_NAMES = [
  'synth',
  'delay',
  'filter',
  'compressor',
  'mixer',
  'distortion',
  'allpass',
];

function float32FromBits(bits) {
  const storage = new ArrayBuffer(4);
  const view = new DataView(storage);
  view.setUint32(0, bits, true);
  return view.getFloat32(0, true);
}

function roundToNearestEven(value) {
  const lower = Math.floor(value);
  const fraction = value - lower;
  if (fraction < 0.5) return lower;
  if (fraction > 0.5) return lower + 1;
  return lower % 2 === 0 ? lower : lower + 1;
}

// The x87 FISTP conversion in the original uses round-to-nearest-even. With
// masked invalid exceptions, unrepresentable int16 values become 0x8000.
function pcm16(value) {
  const rounded = roundToNearestEven(f32(value * FINAL_SCALE));
  if (!Number.isFinite(rounded) || rounded < -32_768 || rounded > 32_767) {
    return -32_768;
  }
  return rounded;
}

function oscillator(type, phase, phaseShift) {
  let value = f32(phase + phaseShift);
  value = f32(value - roundToNearestEven(value));
  value = f32(value + value);

  // FMUL rounds the pi-scaled phase to PC24; FSIN itself does not obey the x87
  // precision-control field. Keep its result in JS double precision until the
  // caller's following FADD/FMUL rounds it.
  if (type === 1) return Math.sin(f32(Math.PI * value));
  if (type === 2) return value > 0 ? 1 : -1;
  return value;
}

class OriginalRandom {
  constructor(seed = 0) {
    this.seed = seed | 0;
  }

  next() {
    this.seed = (Math.imul(this.seed, 16_307) + 17) | 0;
    // SHR 14 followed by FILD word reads the low word as a signed int16.
    const signedWord = ((this.seed >>> 14) << 16) >> 16;
    return f32(signedWord / 32_768);
  }

  skip(count) {
    for (let i = 0; i < count; i++) this.next();
  }
}

function createProgressReporter(callback) {
  if (!callback) return () => {};

  let lastProgress = -1;
  let lastTime = -Infinity;
  return (machineIndex, localProgress, stage, force = false) => {
    const now = globalThis.performance?.now?.() ?? Date.now();
    const progress = Math.min(1, (machineIndex + localProgress) / (MACHINE_COUNT + 1));
    if (!force && progress - lastProgress < 0.002 && now - lastTime < 120) return;
    lastProgress = progress;
    lastTime = now;
    callback({
      progress,
      stage,
      machine: Math.min(machineIndex + 1, MACHINE_COUNT),
      machineCount: MACHINE_COUNT,
    });
  };
}

function renderSynth(stream, parameterOffset, channelIndex, treeView, random, report) {
  const attack = treeView.getInt32(parameterOffset, true);
  const decay = treeView.getInt32(parameterOffset + 4, true);
  const sustain = treeView.getInt32(parameterOffset + 8, true);
  const release = treeView.getInt32(parameterOffset + 12, true);
  const segmentLengths = [attack, decay, sustain, release];
  const noiseMix = treeView.getFloat32(parameterOffset + 16, true);
  const frequencyExponent = treeView.getFloat32(parameterOffset + 20, true);
  const baseFrequency = treeView.getFloat32(parameterOffset + 24, true);
  const volume = treeView.getFloat32(parameterOffset + 28, true);
  const stereo = treeView.getFloat32(parameterOffset + 32, true);

  const oscillatorTypes = new Uint8Array(3);
  const oscillatorOperators = new Uint8Array(3);
  const oscillatorPhases = new Float32Array(3);
  const oscillatorDetunes = new Float32Array(3);
  for (let oscillatorIndex = 0; oscillatorIndex < 3; oscillatorIndex++) {
    const offset = parameterOffset + 36 + oscillatorIndex * 12;
    oscillatorTypes[oscillatorIndex] = treeView.getUint8(offset);
    oscillatorOperators[oscillatorIndex] = treeView.getUint8(offset + 1);
    oscillatorPhases[oscillatorIndex] = treeView.getFloat32(offset + 4, true);
    oscillatorDetunes[oscillatorIndex] = treeView.getFloat32(offset + 8, true);
  }

  const sequenceBase = channelIndex * NUM_ROWS;
  const noteSlots = NUM_ROWS * 16;

  for (let slot = 0; slot < noteSlots; slot++) {
    if ((slot & 31) === 0) report(slot / noteSlots, `synth ${channelIndex + 1}/${NUM_CHANNELS}`);

    const pattern = sequenceData[sequenceBase + (slot >> 4)];
    let note = patternData[pattern * 16 + (slot & 15)];
    note = (note * 2) & 0xff;
    if (note === 0) continue;

    const envelopeScales = note === 0xfe ? STOP_ENVELOPE_SCALES : ENVELOPE_SCALES;
    let frequency = NOTE_FREQ_START;
    for (let i = 0; i < note; i++) frequency = f32(frequency * NOTE_FREQ_STEP);
    frequency = f32(frequency - baseFrequency);

    let phase = 0;
    let envelope = 0;
    let outputFrame = slot * ROW_SAMPLES;

    for (let segment = 0; segment < 4; segment++) {
      const segmentLength = segmentLengths[segment];
      const envelopeStep = f32(envelopeScales[segment] / segmentLength);

      for (let sample = 0; sample < segmentLength; sample++, outputFrame++) {
        envelope = f32(envelope + envelopeStep);
        frequency = f32(frequency * frequencyExponent);
        phase = f32(f32(phase + frequency) + baseFrequency);

        let oscillatorAccumulator = 0;
        for (let oscillatorIndex = 0; oscillatorIndex < 3; oscillatorIndex++) {
          const detune = oscillatorDetunes[oscillatorIndex];
          const phaseShift = oscillatorPhases[oscillatorIndex];
          const type = oscillatorTypes[oscillatorIndex];
          const first = oscillator(type, f32(phase * f32(2 - detune)), phaseShift);
          // After the first oscillator result is left on the x87 stack,
          // `fld st4` addresses the retained phase (frequency has moved to
          // st5). Together the pair uses phase * (2-detune) and phase*detune.
          const second = oscillator(type, f32(phase * detune), phaseShift);
          const pair = f32(first + second);

          switch (oscillatorOperators[oscillatorIndex]) {
            case 2:
              oscillatorAccumulator = f32(oscillatorAccumulator + pair);
              break;
            case 3:
              oscillatorAccumulator = f32(oscillatorAccumulator - pair);
              break;
            case 4:
              oscillatorAccumulator = f32(oscillatorAccumulator * pair);
              break;
            default:
              // Operator 1 is the original synth's no-op/pop operation.
              break;
          }
        }

        const noise = f32(random.next() * noiseMix);
        let value = f32(oscillatorAccumulator + noise);
        value = f32(value * envelope);
        value = f32(value * volume);
        if (outputFrame < TOTAL_SAMPLES) {
          const outputIndex = outputFrame * 2;
          stream[outputIndex] = value;
          stream[outputIndex + 1] = f32(value * stereo);
        }
      }
    }
  }
}

function renderFilter(stream, parameterOffset, treeView, state, report) {
  const cutoff = treeView.getFloat32(parameterOffset, true);
  const resonance = treeView.getFloat32(parameterOffset + 4, true);
  const lfo1Frequency = treeView.getFloat32(parameterOffset + 8, true);
  const lfo2Frequency = treeView.getFloat32(parameterOffset + 16, true);
  const dry = treeView.getFloat32(parameterOffset + 24, true);
  const filterType = treeView.getInt32(parameterOffset + 28, true);

  let sin1 = state[0];
  let sin2 = state[1];
  let cos1 = treeView.getFloat32(parameterOffset + 12, true);
  let cos2 = treeView.getFloat32(parameterOffset + 20, true);
  let lowLeft = state[2];
  let highLeft = state[3];
  let bandLeft = state[4];
  let lowRight = state[5];
  let highRight = state[6];
  let bandRight = state[7];

  for (let frame = 0, index = 0; frame < TOTAL_SAMPLES; frame++, index += 2) {
    if ((frame & 0x7ffff) === 0) report(frame / TOTAL_SAMPLES, 'filter');

    cos1 = f32(cos1 - f32(sin1 * lfo1Frequency));
    sin1 = f32(sin1 + f32(cos1 * lfo1Frequency));

    cos2 = f32(cos2 - f32(sin2 * lfo2Frequency));
    sin2 = f32(sin2 + f32(cos2 * lfo2Frequency));

    let frequency = f32(sin1 + sin2);
    frequency = f32(frequency + cutoff);
    frequency = f32(frequency * CUTOFF_SCALE);

    lowLeft = f32(lowLeft + f32(frequency * bandLeft));
    highLeft = f32(f32(resonance * f32(stream[index] - bandLeft)) - lowLeft);
    const previousBandLeft = bandLeft;
    bandLeft = f32(highLeft * frequency);
    bandLeft = f32(bandLeft + previousBandLeft);
    bandLeft = f32(bandLeft + 2);
    bandLeft = f32(bandLeft - 2);
    const wetLeft = filterType === 0 ? lowLeft : filterType === 1 ? highLeft : bandLeft;
    stream[index] = f32(f32(stream[index] * dry) + wetLeft);

    lowRight = f32(lowRight + f32(frequency * bandRight));
    highRight = f32(f32(resonance * f32(stream[index + 1] - bandRight)) - lowRight);
    const previousBandRight = bandRight;
    bandRight = f32(highRight * frequency);
    bandRight = f32(bandRight + previousBandRight);
    bandRight = f32(bandRight + 2);
    bandRight = f32(bandRight - 2);
    const wetRight = filterType === 0 ? lowRight : filterType === 1 ? highRight : bandRight;
    stream[index + 1] = f32(f32(stream[index + 1] * dry) + wetRight);
  }

  state[0] = sin1;
  state[1] = sin2;
  state[2] = lowLeft;
  state[3] = highLeft;
  state[4] = bandLeft;
  state[5] = lowRight;
  state[6] = highRight;
  state[7] = bandRight;
  treeView.setFloat32(parameterOffset + 12, cos1, true);
  treeView.setFloat32(parameterOffset + 20, cos2, true);
}

function renderDelay(stream, parameterOffset, treeView, delayBuffer, report) {
  let delayPosition = treeView.getInt32(parameterOffset, true);
  const delayLength = treeView.getInt32(parameterOffset + 4, true);
  const feedback = treeView.getFloat32(parameterOffset + 8, true);

  for (let frame = 0, index = 0; frame < TOTAL_SAMPLES; frame++, index += 2) {
    if ((frame & 0x7ffff) === 0) report(frame / TOTAL_SAMPLES, 'delay');
    delayPosition--;
    if (delayPosition < 0) delayPosition += delayLength;
    const delayIndex = delayPosition * 2;
    const left = f32(f32(delayBuffer[delayIndex] * feedback) + stream[index]);
    const right = f32(f32(delayBuffer[delayIndex + 1] * feedback) + stream[index + 1]);
    stream[index] = left;
    stream[index + 1] = right;
    // The two retained x87 values are deliberately stored cross-channel.
    delayBuffer[delayIndex] = right;
    delayBuffer[delayIndex + 1] = left;
  }

  treeView.setInt32(parameterOffset, delayPosition, true);
}

function renderAllpass(stream, parameterOffset, treeView, delayBuffer, report) {
  let delayPosition = treeView.getInt32(parameterOffset, true);
  const delayLength = treeView.getInt32(parameterOffset + 4, true);
  const feedback = treeView.getFloat32(parameterOffset + 8, true);

  for (let frame = 0, index = 0; frame < TOTAL_SAMPLES; frame++, index += 2) {
    if ((frame & 0x7ffff) === 0) report(frame / TOTAL_SAMPLES, 'allpass');
    delayPosition--;
    if (delayPosition < 0) delayPosition += delayLength;
    const delayIndex = delayPosition * 2;
    const wetLeft = delayBuffer[delayIndex];
    const wetRight = delayBuffer[delayIndex + 1];
    const newDelayLeft = f32(f32(wetRight * feedback) + stream[index]);
    const newDelayRight = f32(f32(wetLeft * feedback) + stream[index + 1]);
    const left = f32(wetRight - f32(newDelayLeft * feedback));
    const right = f32(wetLeft - f32(newDelayRight * feedback));
    delayBuffer[delayIndex] = newDelayLeft;
    delayBuffer[delayIndex + 1] = newDelayRight;
    stream[index] = left;
    stream[index + 1] = right;
  }

  treeView.setInt32(parameterOffset, delayPosition, true);
}

function renderCompressor(stream, parameterOffset, treeView, report) {
  const threshold = treeView.getFloat32(parameterOffset, true);
  const ratio = treeView.getFloat32(parameterOffset + 4, true);
  const postAdd = treeView.getFloat32(parameterOffset + 8, true);

  for (let index = 0; index < STEREO_SAMPLES; index++) {
    if ((index & 0xfffff) === 0) report(index / STEREO_SAMPLES, 'compressor');
    const input = stream[index];
    let magnitude = f32(Math.abs(input) - threshold);
    if (magnitude >= 0) magnitude = f32(f32(magnitude * ratio) + postAdd);
    magnitude = f32(magnitude + threshold);
    stream[index] = input < 0 ? -magnitude : magnitude;
  }
}

function renderDistortion(stream, parameterOffset, treeView, report) {
  const amount = treeView.getFloat32(parameterOffset, true);
  const gain = treeView.getFloat32(parameterOffset + 4, true);

  for (let index = 0; index < STEREO_SAMPLES; index++) {
    if ((index & 0xfffff) === 0) report(index / STEREO_SAMPLES, 'distortion');
    const angle = f32(stream[index] * amount);
    // FSIN retains extended precision; only the following FMUL is PC24-rounded.
    stream[index] = f32(Math.sin(angle) * gain);
  }
}

function renderMixer(destination, source, parameterOffset, treeView, report) {
  const sourceVolume = treeView.getFloat32(parameterOffset, true);
  const destinationVolume = treeView.getFloat32(parameterOffset + 4, true);

  for (let index = 0; index < STEREO_SAMPLES; index++) {
    if ((index & 0xfffff) === 0) report(index / STEREO_SAMPLES, 'mixer');
    const sourceSample = f32(source[index] * sourceVolume);
    const destinationSample = f32(destination[index] * destinationVolume);
    destination[index] = f32(sourceSample + destinationSample);
  }
}

/**
 * Render Elevated's original packed song to interleaved signed PCM16.
 *
 * This export also makes the exact worker renderer callable from Node. Node
 * needs to treat .js files as modules (for example
 * `node --experimental-default-type=module ...`) because this source tree has
 * no package.json.
 */
export function renderMusic({ onProgress } = {}) {
  if (patternData.length !== 70 * 16 || sequenceData.length !== NUM_CHANNELS * NUM_ROWS) {
    throw new Error('The packed Elevated music data has an unexpected size.');
  }

  const started = globalThis.performance?.now?.() ?? Date.now();
  const progress = createProgressReporter(onProgress);
  const tree = new Uint8Array(machineTree);
  const treeView = new DataView(tree.buffer, tree.byteOffset, tree.byteLength);
  const random = new OriginalRandom();

  // DemoInit fills the 256x256 R16F noise texture before generateMusic(). The
  // synth shares that PRNG and therefore begins at seed 0x3f720000.
  random.skip(256 * 256);

  const stack = [];
  const bufferPool = [];
  let parameterOffset = 0;
  let machineType = 0; // The first synth opcode is implicit in synth.asm.
  let machineIndex = 0;
  let synthIndex = 0;

  progress(0, 0, 'initializing', true);

  while (machineType < 0x80) {
    if (machineType >= MACHINE_PARAMETER_BYTES.length) {
      throw new Error(`Unknown synth machine opcode ${machineType} at byte ${parameterOffset}.`);
    }

    const machineReport = (local, stage = MACHINE_NAMES[machineType]) => {
      progress(machineIndex, local, stage);
    };
    machineReport(0);

    switch (machineType) {
      case 0: {
        const stream = bufferPool.pop() ?? new Float32Array(STEREO_SAMPLES);
        stream.fill(0);
        stack.push(stream);
        renderSynth(stream, parameterOffset, synthIndex++, treeView, random, machineReport);
        break;
      }
      case 1:
        renderDelay(
          stack.at(-1),
          parameterOffset,
          treeView,
          new Float32Array(MAX_DELAY_SAMPLES * 2),
          machineReport,
        );
        break;
      case 2:
        renderFilter(
          stack.at(-1),
          parameterOffset,
          treeView,
          new Float32Array(8),
          machineReport,
        );
        break;
      case 3:
        renderCompressor(stack.at(-1), parameterOffset, treeView, machineReport);
        break;
      case 4: {
        if (stack.length < 2) throw new Error('Packed synth mixer stack underflow.');
        const source = stack.pop();
        const destination = stack.at(-1);
        renderMixer(destination, source, parameterOffset, treeView, machineReport);
        bufferPool.push(source);
        break;
      }
      case 5:
        renderDistortion(stack.at(-1), parameterOffset, treeView, machineReport);
        break;
      case 6:
        renderAllpass(
          stack.at(-1),
          parameterOffset,
          treeView,
          new Float32Array(MAX_DELAY_SAMPLES * 2),
          machineReport,
        );
        break;
      default:
        break;
    }

    parameterOffset += MACHINE_PARAMETER_BYTES[machineType];
    machineType = treeView.getUint8(parameterOffset++);
    machineIndex++;
    progress(machineIndex, 0, machineType < 0x80 ? MACHINE_NAMES[machineType] : 'quantizing', true);
  }

  if (machineIndex !== MACHINE_COUNT || synthIndex !== NUM_CHANNELS || stack.length !== 1) {
    throw new Error(
      `Packed synth graph mismatch (${machineIndex} machines, ${synthIndex} channels, stack ${stack.length}).`,
    );
  }

  const finalStream = stack[0];
  const pcm = new Int16Array(STEREO_SAMPLES);
  for (let index = 0; index < STEREO_SAMPLES; index++) {
    if ((index & 0xfffff) === 0) {
      progress(MACHINE_COUNT, index / STEREO_SAMPLES, 'quantizing');
    }
    pcm[index] = pcm16(finalStream[index]);
  }

  const ended = globalThis.performance?.now?.() ?? Date.now();
  progress(MACHINE_COUNT + 1, 0, 'complete', true);
  return {
    pcm,
    sampleRate: SAMPLE_RATE,
    totalSamples: TOTAL_SAMPLES,
    exitSample: EXIT_SAMPLE,
    renderMs: ended - started,
  };
}

let rendering = false;

const isWorkerScope =
  typeof self !== 'undefined' &&
  typeof self.postMessage === 'function' &&
  typeof document === 'undefined';

if (isWorkerScope) {
  self.addEventListener('message', (event) => {
    if (event.data?.type !== 'render' || rendering) return;
    rendering = true;

    try {
      const result = renderMusic({
        onProgress(update) {
          self.postMessage({ type: 'progress', ...update });
        },
      });
      self.postMessage(
        {
          type: 'complete',
          pcm: result.pcm.buffer,
          sampleRate: result.sampleRate,
          totalSamples: result.totalSamples,
          exitSample: result.exitSample,
          renderMs: result.renderMs,
        },
        [result.pcm.buffer],
      );
    } catch (error) {
      self.postMessage({
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
    } finally {
      rendering = false;
    }
  });
}
