import { ElevatedAudio, SAMPLE_RATE } from './audio.js';
import { Renderer } from './renderer.js';
import {
  EXIT_SAMPLE,
  evaluateInstrumentAges,
  evaluateTimeline,
  secondsToSamplePosition,
} from './timeline.js';

const canvas = document.querySelector('#screen');
const launcher = document.querySelector('#launcher');
const startButton = document.querySelector('#start');
const progress = document.querySelector('#progress');
const status = document.querySelector('#status');

const sync = new Float32Array(12);
const instrumentAges = new Float32Array(8);
const query = new URLSearchParams(location.search);
const staticTime = query.get('time');

if (staticTime !== null) document.documentElement.dataset.static = 'true';

let renderer;
let audio;
let animationFrame = 0;
let lastRenderedSample = -1;
let launchGeneration = 0;
let starting = false;
let flashTimer = 0;
let wakeLock = null;
let wakeLockPending = false;
let wakeLockGeneration = 0;

function setStatus(message) {
  status.textContent = message;
}

function setProgress(message) {
  progress.textContent = message;
}

function setBusy(busy) {
  progress.setAttribute('aria-busy', String(busy));
}

function renderAt(samplePosition) {
  const sample = Math.max(0, Math.min(EXIT_SAMPLE, Math.floor(samplePosition)));
  evaluateTimeline(sample, sync);
  evaluateInstrumentAges(sample, instrumentAges);
  renderer.render(sample, { sync, instrumentSync: instrumentAges });
  lastRenderedSample = sample;
  return sample;
}

function stopAnimation() {
  cancelAnimationFrame(animationFrame);
  animationFrame = 0;
}

function demoIsActive() {
  return launcher.classList.contains('hidden') &&
    (starting || audio?.state === 'playing' || audio?.state === 'paused');
}

async function lockScreen() {
  if (!('wakeLock' in navigator) || wakeLock || wakeLockPending || document.hidden) return;

  const generation = wakeLockGeneration;
  wakeLockPending = true;
  try {
    const lock = await navigator.wakeLock.request('screen');
    if (generation !== wakeLockGeneration || !demoIsActive()) {
      await lock.release();
      return;
    }
    wakeLock = lock;
    lock.addEventListener('release', () => {
      if (wakeLock === lock) wakeLock = null;
    }, { once: true });
  } catch {
    wakeLock = null;
  } finally {
    wakeLockPending = false;
  }
}

function unlockScreen() {
  wakeLockGeneration++;
  const lock = wakeLock;
  wakeLock = null;
  lock?.release().catch(() => {});
}

function showLauncher(message = '', { label = 'START', error = false } = {}) {
  launchGeneration++;
  starting = false;
  stopAnimation();
  unlockScreen();
  launcher.classList.remove('hidden');
  launcher.classList.toggle('error', error);
  canvas.classList.remove('visible');
  startButton.disabled = !audio?.ready;
  startButton.textContent = label;
  setBusy(false);
  setProgress('');
  setStatus(message);
  if (error) document.documentElement.dataset.error = 'true';
  else delete document.documentElement.dataset.error;
}

function animate() {
  animationFrame = 0;
  if (!audio || audio.state === 'paused') return;
  if (audio.state === 'ended') {
    showLauncher();
    return;
  }
  if (audio.state !== 'playing') return;

  const sample = audio.getSamplePosition();
  // main_rel.asm exits before demoeffect_asm at the terminal sample.
  if (sample >= EXIT_SAMPLE) {
    showLauncher();
    return;
  }

  if (sample !== lastRenderedSample) renderAt(sample);
  animationFrame = requestAnimationFrame(animate);
}

async function begin() {
  if (!audio || startButton.disabled || starting) return;

  const generation = ++launchGeneration;
  starting = true;
  launcher.classList.remove('error');
  launcher.classList.add('hidden');
  canvas.classList.remove('visible');
  startButton.disabled = true;
  startButton.textContent = 'STARTING';
  setBusy(true);
  setProgress('');
  setStatus('');
  document.documentElement.removeAttribute('data-error');

  try {
    await audio.start(0);
    if (generation !== launchGeneration) {
      audio.stop();
      return;
    }

    renderAt(0);
    starting = false;
    canvas.classList.add('visible');
    startButton.disabled = false;
    startButton.textContent = 'START';
    setBusy(false);
    void lockScreen();
    stopAnimation();
    animationFrame = requestAnimationFrame(animate);
  } catch (error) {
    if (generation !== launchGeneration) return;
    showLauncher(error instanceof Error ? error.message : String(error), {
      label: 'RETRY',
      error: true,
    });
  }
}

function stop() {
  if (!audio || !demoIsActive()) return;
  audio.stop();
  showLauncher();
}

function formatProgress(update) {
  if (update.phase === 'audio') {
    if (update.stage === 'ready') return '';
    return `${update.stage} ${Math.round((update.progress ?? 0) * 100)}%`;
  }

  const percent = Math.round((update.progress ?? 0) * 100);
  return `${update.stage ?? 'rendering soundtrack'} ${percent}%`;
}

function formatTime(samplePosition) {
  const seconds = Math.round(samplePosition / SAMPLE_RATE);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function flash(message) {
  clearTimeout(flashTimer);
  setStatus(message);
  flashTimer = setTimeout(() => {
    if (status.textContent === message) setStatus('');
  }, 1_200);
}

async function seekBy(seconds) {
  if (!audio || !demoIsActive() || (audio.state !== 'playing' && audio.state !== 'paused')) return;

  const generation = launchGeneration;
  const target = Math.max(0, Math.min(
    EXIT_SAMPLE,
    audio.getSamplePosition() + seconds * SAMPLE_RATE,
  ));

  try {
    await audio.seek(target);
    if (generation !== launchGeneration) {
      audio.stop();
      return;
    }
    renderAt(target);
    flash(`${seconds < 0 ? '◀' : '▶'} ${formatTime(target)}`);
    if (audio.state === 'playing' && !animationFrame) {
      animationFrame = requestAnimationFrame(animate);
    }
  } catch (error) {
    if (generation !== launchGeneration) return;
    audio.stop();
    showLauncher(error instanceof Error ? error.message : String(error), {
      label: 'RETRY',
      error: true,
    });
  }
}

async function togglePause() {
  if (!audio || !demoIsActive() || (audio.state !== 'playing' && audio.state !== 'paused')) return;

  const generation = launchGeneration;
  try {
    await audio.togglePause();
    if (generation !== launchGeneration) return;
    flash(audio.state === 'paused'
      ? `PAUSED · ${formatTime(audio.getSamplePosition())}`
      : `PLAYING · ${formatTime(audio.getSamplePosition())}`);
    if (audio.state === 'playing' && !animationFrame) {
      animationFrame = requestAnimationFrame(animate);
    }
  } catch (error) {
    if (generation !== launchGeneration) return;
    audio.stop();
    showLauncher(error instanceof Error ? error.message : String(error), {
      label: 'RETRY',
      error: true,
    });
  }
}

async function toggleFullscreen() {
  if (!document.fullscreenEnabled) return;
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch {
    // Fullscreen can be denied by browser or embedding policy.
  }
}

async function bootstrap() {
  // Let the branded launcher paint before mesh generation and shader compilation.
  await new Promise((resolve) => requestAnimationFrame(resolve));

  const width = Number(query.get('width')) || undefined;
  const height = Number(query.get('height')) || undefined;
  const tessellation = Number(query.get('tessellation')) || undefined;

  renderer = new Renderer(canvas, { width, height, tessellation });

  // A deterministic still-frame mode is useful for regression captures and
  // does not start the several-second procedural soundtrack render.
  if (staticTime !== null) {
    const sample = renderAt(secondsToSamplePosition(Number(staticTime)));
    renderer.gl.finish();
    launcher.classList.add('hidden');
    canvas.classList.add('visible');
    setBusy(false);
    setProgress('');
    setStatus('');
    document.documentElement.dataset.ready = 'true';
    globalThis.elevated = { renderer, renderAt, samplePosition: sample };
    return;
  }

  renderAt(0);
  audio = new ElevatedAudio({
    onProgress(update) {
      setProgress(formatProgress(update));
    },
    onStateChange({ state }) {
      if (state === 'ended' && launcher.classList.contains('hidden')) showLauncher();
    },
  });

  globalThis.elevated = { renderer, audio, renderAt };
  await audio.prepare();
  launcher.classList.add('ready');
  startButton.disabled = false;
  startButton.textContent = 'START';
  setBusy(false);
  setProgress('');
  setStatus('');
  document.documentElement.dataset.ready = 'true';
}

startButton.addEventListener('click', begin);

addEventListener('keydown', (event) => {
  if (event.repeat) return;

  if (event.code === 'Escape') {
    stop();
    return;
  }

  if (event.code === 'KeyF') {
    void toggleFullscreen();
    return;
  }

  if (event.code === 'Space') {
    event.preventDefault();
    if (!launcher.classList.contains('hidden')) {
      if (!startButton.disabled) void begin();
    } else {
      void togglePause();
    }
    return;
  }

  if (event.code === 'ArrowLeft' || event.code === 'ArrowRight') {
    if (!demoIsActive()) return;
    event.preventDefault();
    void seekBy(event.code === 'ArrowLeft' ? -5 : 5);
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && demoIsActive() && !wakeLock) {
    void lockScreen();
  }
});

addEventListener('beforeunload', () => {
  stopAnimation();
  unlockScreen();
  audio?.dispose();
  renderer?.dispose();
});

canvas.addEventListener('webglcontextlost', (event) => {
  event.preventDefault();
  audio?.stop();
  showLauncher('WebGL context lost. Reload to restart.', {
    label: 'UNAVAILABLE',
    error: true,
  });
  startButton.disabled = true;
});

bootstrap().catch((error) => {
  console.error(error);
  stopAnimation();
  unlockScreen();
  launcher.classList.remove('hidden');
  launcher.classList.add('error');
  canvas.classList.remove('visible');
  startButton.disabled = true;
  startButton.textContent = 'LOAD FAILED';
  setBusy(false);
  setProgress('');
  setStatus(error instanceof Error ? error.message : String(error));
  document.documentElement.dataset.error = 'true';
});
