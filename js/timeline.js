import { patternData, sequenceData, timelineTracks } from './source-data.js';

// Audio/timeline constants from constants.h and music.h.
export const SAMPLE_RATE = 44_100;
export const NOTE_SAMPLES = 5_210;
export const NOTES_PER_PATTERN = 16;
export const ROW_SAMPLES = NOTE_SAMPLES * 4;
export const NUM_ROWS = 114;
export const NUM_CHANNELS = 12;
export const MELODY_CHANNEL = 2;
export const INSTRUMENT_SYNC_SLOTS = 8;

// The synth renders a padded buffer, while the release executable exits at
// the preceding 64K-sample boundary. Keep both durations explicit.
export const MUSIC_SAMPLES = NUM_ROWS * NOTES_PER_PATTERN * NOTE_SAMPLES;
export const TOTAL_SAMPLES = (MUSIC_SAMPLES + 65_535) & 0xffff0000;
export const EXIT_SAMPLE = MUSIC_SAMPLES & 0xffff0000;
export const DURATION_SECONDS = EXIT_SAMPLE / SAMPLE_RATE;
export const AUDIO_DURATION_SECONDS = TOTAL_SAMPLES / SAMPLE_RATE;
export const ROW_SECONDS = ROW_SAMPLES / SAMPLE_RATE;

// This order is the original constant-pool order (c0 through c2).
export const TIMELINE_PARAMETER_NAMES = Object.freeze([
  'camSeedX',
  'camSeedY',
  'camSpeed',
  'camFov',
  'camPosY',
  'camTarY',
  'sun_angle',
  'terWaterLevel',
  'terSeason',
  'imgBrightness',
  'imgContrast',
  'terScale',
]);

export const TIMELINE_PARAMETER_INDEX = Object.freeze(
  Object.fromEntries(TIMELINE_PARAMETER_NAMES.map((name, index) => [name, index])),
);
export const TIMELINE_PARAMETER_COUNT = TIMELINE_PARAMETER_NAMES.length;

// Pairs from demo_rel.asm:_param_scales. A release value is
// (raw - offset) / divisor, rounded once when written to constantPool.
const PARAMETER_OFFSETS = Object.freeze([0, 0, 0, 0, 0, 128, 0, 192, 0, 128, 0, 128]);
const PARAMETER_DIVISORS = Object.freeze([256, 256, 4096, 96, 64, 4, 32, 128, 256, 128, 128, 128]);

export const TIMELINE_SENTINEL_ROW = 512;

function buildReleaseSegments() {
  // timelineTracks comes from the readable debug data, but release packing is
  // global: any track key starts a new 15-byte block for all twelve tracks.
  // The {512} entries are C-side sentinels and are absent from timeline.sync.
  const tracks = TIMELINE_PARAMETER_NAMES.map((name) => {
    const track = timelineTracks[name];
    if (!track) throw new Error(`Missing original timeline track: ${name}`);
    return track.filter(([row]) => row < TIMELINE_SENTINEL_ROW);
  });

  const rows = [...new Set(tracks.flatMap((track) => track.map(([row]) => row)))].sort((a, b) => a - b);
  const cursors = new Uint16Array(TIMELINE_PARAMETER_COUNT);

  return rows.map((row) => {
    const raw = new Uint8Array(TIMELINE_PARAMETER_COUNT);
    const linear = new Uint8Array(TIMELINE_PARAMETER_COUNT);

    for (let parameter = 0; parameter < TIMELINE_PARAMETER_COUNT; parameter += 1) {
      const track = tracks[parameter];
      let cursor = cursors[parameter];
      while (cursor + 1 < track.length && track[cursor + 1][0] <= row) cursor += 1;
      cursors[parameter] = cursor;

      const [keyRow, value, interpolation] = track[cursor];
      raw[parameter] = value;

      // This intentionally tests keyRow === row instead of carrying a linear
      // flag through later global blocks. That is what the packed release
      // evaluator does (notably for terSeason across the row-293 block).
      linear[parameter] = keyRow === row && interpolation !== 0 ? 1 : 0;
    }

    return { row, sample: row * ROW_SAMPLES, raw, linear };
  });
}

const RELEASE_SEGMENTS = buildReleaseSegments();

// Useful for diagnostics/seeking UIs without exposing mutable segment data.
export const RELEASE_TIMELINE_ROWS = Object.freeze(RELEASE_SEGMENTS.map(({ row }) => row));

function normalizeSamplePosition(samplePosition) {
  const value = Number(samplePosition);
  if (Number.isNaN(value) || value <= 0) return 0;
  if (!Number.isFinite(value) || value >= EXIT_SAMPLE) return EXIT_SAMPLE;
  return Math.trunc(value);
}

/** Convert seconds to the integer sample clock used by the release intro. */
export function secondsToSamplePosition(seconds) {
  return normalizeSamplePosition(Number(seconds) * SAMPLE_RATE);
}

/** Clamp/truncate a value to the release intro's valid integer sample range. */
export function clampSamplePosition(samplePosition) {
  return normalizeSamplePosition(samplePosition);
}

function findSegmentIndex(samplePosition) {
  let low = 0;
  let high = RELEASE_SEGMENTS.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (RELEASE_SEGMENTS[middle].sample <= samplePosition) low = middle + 1;
    else high = middle;
  }
  return Math.max(0, low - 1);
}

function rawValueAt(segmentIndex, parameter, samplePosition) {
  const segment = RELEASE_SEGMENTS[segmentIndex];
  const value = segment.raw[parameter];
  const next = RELEASE_SEGMENTS[segmentIndex + 1];
  if (!next || segment.linear[parameter] === 0) return value;

  // CreateDevice omits D3DCREATE_FPU_PRESERVE, putting x87 in PC24 mode
  // before the release evaluator runs. Preserve both its operation order and
  // the single-precision result of each FSUB/FDIV/FIMUL/FADD.
  const delta = Math.fround(next.raw[parameter] - value);
  const deltaPerSample = Math.fround(delta / (next.sample - segment.sample));
  const interpolatedDelta = Math.fround(
    deltaPerSample * (samplePosition - segment.sample),
  );
  return Math.fround(value + interpolatedDelta);
}

function requireOutput(output, length, label) {
  if (output.length < length) {
    throw new RangeError(`${label} output needs at least ${length} elements`);
  }
  return output;
}

/**
 * Evaluate the twelve unscaled byte-domain automation values.
 *
 * The default Float64Array is convenient for callers, but every returned
 * value has already been PC24-rounded exactly where the release rounds it.
 */
export function evaluateRawTimeline(samplePosition, output = new Float64Array(TIMELINE_PARAMETER_COUNT)) {
  requireOutput(output, TIMELINE_PARAMETER_COUNT, 'Timeline');
  const sample = normalizeSamplePosition(samplePosition);
  const segmentIndex = findSegmentIndex(sample);

  for (let parameter = 0; parameter < TIMELINE_PARAMETER_COUNT; parameter += 1) {
    output[parameter] = rawValueAt(segmentIndex, parameter, sample);
  }
  return output;
}

/**
 * Evaluate the twelve scaled automation constants in original constant-pool
 * order. Results are explicitly float32-rounded like x87 `fstp dword`.
 */
export function evaluateTimeline(samplePosition, output = new Float32Array(TIMELINE_PARAMETER_COUNT)) {
  requireOutput(output, TIMELINE_PARAMETER_COUNT, 'Timeline');
  const sample = normalizeSamplePosition(samplePosition);
  const segmentIndex = findSegmentIndex(sample);

  for (let parameter = 0; parameter < TIMELINE_PARAMETER_COUNT; parameter += 1) {
    const raw = rawValueAt(segmentIndex, parameter, sample);
    const offsetValue = Math.fround(raw - PARAMETER_OFFSETS[parameter]);
    output[parameter] = Math.fround(offsetValue / PARAMETER_DIVISORS[parameter]);
  }
  return output;
}

function buildMelodyEvents() {
  const events = Array.from({ length: INSTRUMENT_SYNC_SLOTS }, () => []);
  const stepCount = NUM_ROWS * NOTES_PER_PATTERN;
  const sequenceOffset = MELODY_CHANNEL * NUM_ROWS;

  for (let step = 0; step < stepCount; step += 1) {
    const pattern = sequenceData[sequenceOffset + (step >>> 4)];
    const note = patternData[(pattern << 4) | (step & 15)];
    if (note !== 0) events[note & 7].push(step * NOTE_SAMPLES);
  }
  return events;
}

const MELODY_EVENTS = buildMelodyEvents();

function latestEventAtOrBefore(events, samplePosition) {
  let low = 0;
  let high = events.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (events[middle] <= samplePosition) low = middle + 1;
    else high = middle;
  }
  return low === 0 ? -1 : events[low - 1];
}

/**
 * Return the eight melody-ray ages, in samples, used by q[5]..q[12].x.
 * Notes on the current sample are active immediately; untouched slots retain
 * the current sample position, matching the release clear/overwrite loops.
 */
export function evaluateInstrumentAges(
  samplePosition,
  output = new Float32Array(INSTRUMENT_SYNC_SLOTS),
) {
  requireOutput(output, INSTRUMENT_SYNC_SLOTS, 'Instrument sync');
  const sample = normalizeSamplePosition(samplePosition);

  for (let slot = 0; slot < INSTRUMENT_SYNC_SLOTS; slot += 1) {
    const eventSample = latestEventAtOrBefore(MELODY_EVENTS[slot], sample);
    output[slot] = Math.fround(eventSample < 0 ? sample : sample - eventSample);
  }
  return output;
}

/**
 * Fill the release's sync-owned portion of its float constant pool.
 *
 * Layout: [0..11] automation, [12..14] sun, [15] time, [16..19]
 * camera (left untouched), and q[5]..q[12] at [20..51]. The release clears
 * all four lanes of each instrument vector to the current sample age before
 * replacing each x lane with the latest note age.
 */
export function updateSyncConstantPool(
  samplePosition,
  output = new Float32Array(52),
) {
  requireOutput(output, 52, 'Constant pool');
  const sample = normalizeSamplePosition(samplePosition);
  evaluateTimeline(sample, output);

  const sunAngle = output[TIMELINE_PARAMETER_INDEX.sun_angle];
  output[12] = Math.fround(Math.cos(sunAngle));
  output[13] = 0.3125;
  output[14] = Math.fround(Math.sin(sunAngle));
  output[15] = Math.fround(sample / SAMPLE_RATE);

  for (let index = 20; index < 52; index += 1) output[index] = Math.fround(sample);

  for (let slot = 0; slot < INSTRUMENT_SYNC_SLOTS; slot += 1) {
    const eventSample = latestEventAtOrBefore(MELODY_EVENTS[slot], sample);
    output[20 + slot * 4] = Math.fround(eventSample < 0 ? sample : sample - eventSample);
  }
  return output;
}
