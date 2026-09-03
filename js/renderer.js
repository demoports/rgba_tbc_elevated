import { patternData, sequenceData } from './source-data.js';
import {
  fullscreenVertexShader,
  terrainVertexShader,
  terrainFragmentShader,
  cameraFragmentShader,
  colorFragmentShader,
  postFragmentShader,
} from './shaders.js';

export const RENDER_WIDTH = 1920;
export const RENDER_HEIGHT = 1080;
export const NOISE_SIZE = 256;
export const NOISE_SEED = 0;
// DemoInit fills the texture before generateMusic uses the same global PRNG.
export const NOISE_SEED_AFTER_TEXTURE = 0x3f720000;
export const SAMPLE_RATE = 44100;
export const MAX_NOTE_SAMPLES = 5210;
export const RELEASE_PROJECTION_ASPECT = 1.75;
export const RELEASE_SHUTTER_SECONDS = 0.041748046875; // float 0x3d2b0000

const RENDER_ASPECT = RENDER_WIDTH / RENDER_HEIGHT;
const NUM_ROWS = 114;
const CAMERA_NEAR = 0.03125;
const CAMERA_FAR = 256.0;
const D3DX_PI = Math.fround(3.141592654);

function positiveFiniteOrOne(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 1;
}

function fitRenderSizeWithinLimits(width, height, maxWidth, maxHeight) {
  const requestedWidth = Math.floor(Number(width));
  const requestedHeight = Math.floor(Number(height));
  const widthLimit = Number(maxWidth);
  const heightLimit = Number(maxHeight);

  if (
    !Number.isFinite(requestedWidth)
    || !Number.isFinite(requestedHeight)
    || requestedWidth < 1
    || requestedHeight < 1
  ) {
    throw new RangeError('Render dimensions must be at least one pixel');
  }
  if (
    widthLimit < 1
    || heightLimit < 1
    || Number.isNaN(widthLimit)
    || Number.isNaN(heightLimit)
  ) {
    throw new RangeError('Render limits must be at least one pixel');
  }

  const scale = Math.min(1, widthLimit / requestedWidth, heightLimit / requestedHeight);
  return {
    width: Math.max(1, Math.floor(requestedWidth * scale)),
    height: Math.max(1, Math.floor(requestedHeight * scale)),
  };
}

/** Selects a contained 16:9 physical-pixel size within the supplied limits. */
export function getAdaptiveRenderSize(
  viewportWidth,
  viewportHeight,
  pixelRatio = 1,
  maxWidth = Number.POSITIVE_INFINITY,
  maxHeight = Number.POSITIVE_INFINITY,
) {
  const dpr = positiveFiniteOrOne(pixelRatio);
  const availableWidth = positiveFiniteOrOne(viewportWidth) * dpr;
  const availableHeight = positiveFiniteOrOne(viewportHeight) * dpr;
  let width = Math.round(availableWidth);
  let height = Math.round(availableHeight);

  if (availableWidth / availableHeight > RENDER_ASPECT) {
    width = Math.round(availableHeight * RENDER_ASPECT);
  } else {
    height = Math.round(availableWidth / RENDER_ASPECT);
  }

  return fitRenderSizeWithinLimits(width, height, maxWidth, maxHeight);
}

const DEFAULT_Q = new Float32Array([
  98 / 256, 0 / 256, 1 / 4096, 53 / 96,
  4 / 64, (32 - 128) / 4, 64 / 32, (154 - 192) / 128,
  0 / 256, (0 - 128) / 128, 150 / 128, (200 - 128) / 128,
]);

function advanceRandomSeed(seed, count) {
  let state = seed | 0;
  for (let i = 0; i < count; ++i) {
    state = (Math.imul(state, 16307) + 17) | 0;
  }
  return state >>> 0;
}

/** Recreates TextureFillCallback/frandom, including its signed-word load. */
export function createNoiseData(seed = NOISE_SEED) {
  const result = new Float32Array(NOISE_SIZE * NOISE_SIZE);
  let state = seed | 0;
  for (let i = 0; i < result.length; ++i) {
    state = (Math.imul(state, 16307) + 17) | 0;
    const shifted = state >>> 14;
    const signedWord = (shifted << 16) >> 16;
    result[i] = signedWord / 32768;
  }
  return result;
}

/** Useful to keep a separately implemented synth on the shared x86 PRNG stream. */
export function noiseSeedAfterTexture(seed = NOISE_SEED) {
  return advanceRandomSeed(seed, NOISE_SIZE * NOISE_SIZE);
}

function numberedSource(source) {
  return source.split('\n').map((line, index) => `${String(index + 1).padStart(4)} | ${line}`).join('\n');
}

function compileShader(gl, type, source, label) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`${label} shader failed to compile:\n${log}\n${numberedSource(source)}`);
  }
  return shader;
}

function createProgram(gl, vertexSource, fragmentSource, label) {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource, `${label} vertex`);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource, `${label} fragment`);
  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`${label} program failed to link:\n${log}`);
  }

  const location = (name) => gl.getUniformLocation(program, name);
  let qVectors = 0;
  const activeUniformCount = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
  for (let index = 0; index < activeUniformCount; ++index) {
    const uniform = gl.getActiveUniform(program, index);
    if (uniform && (uniform.name === 'q[0]' || uniform.name === 'q')) {
      qVectors = uniform.size;
      break;
    }
  }
  return {
    program,
    q: location('q[0]'),
    qVectors,
    v: location('v'),
    resolution: location('uResolution'),
    noise: location('uNoise'),
    data: location('uData'),
    color: location('uColor'),
  };
}

function bindTexture(gl, unit, texture) {
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, texture);
}

function throwOnGlError(gl, label) {
  const error = gl.getError();
  if (error !== gl.NO_ERROR) {
    throw new Error(`${label} failed (WebGL error 0x${error.toString(16)})`);
  }
}

function discardPendingGlErrors(gl) {
  while (gl.getError() !== gl.NO_ERROR) {
    // Drain the global queue so the allocation checks have a clean boundary.
  }
}

function createTexture(gl, {
  width,
  height,
  internalFormat,
  format,
  type,
  data = null,
  wrap = gl.REPEAT,
  label = 'texture',
}) {
  const texture = gl.createTexture();
  if (!texture) throw new Error(`Unable to create ${label}`);
  try {
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_BASE_LEVEL, 0);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, 0);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, width, height, 0, format, type, data);
    throwOnGlError(gl, `${label} allocation`);
    return texture;
  } catch (error) {
    gl.deleteTexture(texture);
    throw error;
  }
}

function createFramebuffer(gl, texture, depth = null, label = 'framebuffer') {
  const framebuffer = gl.createFramebuffer();
  if (!framebuffer) throw new Error(`Unable to create ${label}`);
  try {
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      texture,
      0,
    );
    if (depth) {
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
    }
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(`${label} is incomplete (WebGL status 0x${status.toString(16)})`);
    }
    return framebuffer;
  } catch (error) {
    gl.deleteFramebuffer(framebuffer);
    throw error;
  }
}

function createDepthBuffer(gl, width, height, label = 'depth buffer') {
  const depth = gl.createRenderbuffer();
  if (!depth) throw new Error(`Unable to create ${label}`);
  try {
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, width, height);
    throwOnGlError(gl, `${label} allocation`);
    return depth;
  } catch (error) {
    gl.deleteRenderbuffer(depth);
    throw error;
  }
}

function deleteRenderTargets(gl, targets) {
  if (!targets) return;
  gl.deleteFramebuffer(targets.gBufferFramebuffer);
  gl.deleteFramebuffer(targets.colorFramebuffer);
  gl.deleteRenderbuffer(targets.depthBuffer);
  gl.deleteTexture(targets.gBufferTexture);
  gl.deleteTexture(targets.colorTexture);
}

function createRenderTargets(gl, width, height) {
  const targets = {
    gBufferTexture: null,
    colorTexture: null,
    depthBuffer: null,
    gBufferFramebuffer: null,
    colorFramebuffer: null,
  };

  try {
    targets.gBufferTexture = createTexture(gl, {
      width,
      height,
      internalFormat: gl.RGBA32F,
      format: gl.RGBA,
      type: gl.FLOAT,
      wrap: gl.REPEAT,
      label: `world-position texture (${width}x${height})`,
    });
    targets.colorTexture = createTexture(gl, {
      width,
      height,
      internalFormat: gl.RGBA8,
      format: gl.RGBA,
      type: gl.UNSIGNED_BYTE,
      wrap: gl.CLAMP_TO_EDGE,
      label: `lighting texture (${width}x${height})`,
    });
    targets.depthBuffer = createDepthBuffer(gl, width, height, `depth buffer (${width}x${height})`);
    targets.gBufferFramebuffer = createFramebuffer(
      gl,
      targets.gBufferTexture,
      targets.depthBuffer,
      `world-position G-buffer (${width}x${height})`,
    );
    targets.colorFramebuffer = createFramebuffer(
      gl,
      targets.colorTexture,
      null,
      `RGBA8 lighting target (${width}x${height})`,
    );
    return targets;
  } catch (error) {
    deleteRenderTargets(gl, targets);
    throw error;
  } finally {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }
}

/**
 * Recreates D3DXCreatePolygon(..., 52, 4) followed by the flat 512-segment
 * N-patch tessellation. Patch boundary vertices are duplicated, matching the
 * D3DX output count. Connectivity is raster-equivalent; D3DX's final
 * OptimizeInplace vertex-cache index order is deliberately not reproduced.
 */
export function createTerrainMeshData(segments = 512) {
  const n = Math.max(1, Math.floor(segments));
  let angle = Math.fround(D3DX_PI / 4);
  const sine = Math.fround(Math.sin(angle));
  const radius = Math.fround(Math.fround(0.5 * 52.0) / sine);
  angle = Math.fround(angle * 2.0);

  const outer = new Float32Array(10);
  for (let i = 0; i < 4; ++i) {
    const a = Math.fround(angle * i);
    outer[i * 2] = Math.fround(Math.fround(Math.cos(a)) * radius);
    outer[i * 2 + 1] = Math.fround(Math.fround(Math.sin(a)) * radius);
  }
  outer[8] = outer[0];
  outer[9] = outer[1];

  const verticesPerPatch = ((n + 1) * (n + 2)) / 2;
  const triangleCount = 4 * n * n;
  const positions = new Float32Array(4 * verticesPerPatch * 2);
  const indices = new Uint32Array(triangleCount * 3);
  const rowStart = new Uint32Array(n + 1);
  let rowOffset = 0;
  for (let row = 0; row <= n; ++row) {
    rowStart[row] = rowOffset;
    rowOffset += n - row + 1;
  }

  let vertexCursor = 0;
  let indexCursor = 0;
  for (let patch = 0; patch < 4; ++patch) {
    const patchVertexBase = patch * verticesPerPatch;
    const bx = outer[patch * 2];
    const by = outer[patch * 2 + 1];
    const cx = outer[patch * 2 + 2];
    const cy = outer[patch * 2 + 3];

    for (let b = 0; b <= n; ++b) {
      for (let c = 0; c <= n - b; ++c) {
        positions[vertexCursor++] = (bx * b + cx * c) / n;
        positions[vertexCursor++] = (by * b + cy * c) / n;
      }
    }

    for (let b = 0; b < n; ++b) {
      const width = n - b;
      for (let c = 0; c < width; ++c) {
        const p00 = patchVertexBase + rowStart[b] + c;
        const p10 = patchVertexBase + rowStart[b + 1] + c;
        const p01 = patchVertexBase + rowStart[b] + c + 1;
        indices[indexCursor++] = p00;
        indices[indexCursor++] = p10;
        indices[indexCursor++] = p01;

        if (c + 1 < width) {
          const p11 = patchVertexBase + rowStart[b + 1] + c + 1;
          indices[indexCursor++] = p10;
          indices[indexCursor++] = p11;
          indices[indexCursor++] = p01;
        }
      }
    }
  }

  return { positions, indices, triangleCount, segments: n, radius };
}

const D3DX_NORMALIZE_EPSILON_SQUARED = 1.4210854715202004e-14; // float 0x28800000

// d3dx9_33 dispatches these routines to SSE/SSE2 on the CPUs relevant to the
// release. Math.fround preserves the DLL's scalar-float instruction boundaries.
function normalize3(xValue, yValue, zValue) {
  const x = Math.fround(xValue);
  const y = Math.fround(yValue);
  const z = Math.fround(zValue);
  const squaredLength = Math.fround(
    Math.fround(Math.fround(x * x) + Math.fround(y * y)) + Math.fround(z * z),
  );
  if (!(squaredLength >= D3DX_NORMALIZE_EPSILON_SQUARED)) return [0, 0, 0];

  // SSE uses rsqrtss followed by this Newton step. Its estimate is deliberately
  // CPU-dependent, so JavaScript's correctly rounded reciprocal square root is
  // the closest portable seed; the representative release fixture is exact.
  let inverseLength = Math.fround(1 / Math.sqrt(squaredLength));
  const squaredEstimate = Math.fround(
    Math.fround(inverseLength * squaredLength) * inverseLength,
  );
  inverseLength = Math.fround(
    Math.fround(3 - squaredEstimate) * Math.fround(inverseLength * 0.5),
  );
  return [
    Math.fround(x * inverseLength),
    Math.fround(y * inverseLength),
    Math.fround(z * inverseLength),
  ];
}

function cross3(a, b) {
  return [
    Math.fround(Math.fround(a[1] * b[2]) - Math.fround(a[2] * b[1])),
    Math.fround(Math.fround(a[2] * b[0]) - Math.fround(a[0] * b[2])),
    Math.fround(Math.fround(a[0] * b[1]) - Math.fround(a[1] * b[0])),
  ];
}

function dot3(a, b) {
  return Math.fround(
    Math.fround(Math.fround(a[0] * b[0]) + Math.fround(a[1] * b[1]))
      + Math.fround(a[2] * b[2]),
  );
}

function lookAtLH(out, eye, target, up) {
  const z = normalize3(
    Math.fround(target[0] - eye[0]),
    Math.fround(target[1] - eye[1]),
    Math.fround(target[2] - eye[2]),
  );
  const xUnnormalized = cross3(up, z);
  const x = normalize3(xUnnormalized[0], xUnnormalized[1], xUnnormalized[2]);
  const y = cross3(z, x);

  out[0] = x[0]; out[1] = y[0]; out[2] = z[0]; out[3] = 0;
  out[4] = x[1]; out[5] = y[1]; out[6] = z[1]; out[7] = 0;
  out[8] = x[2]; out[9] = y[2]; out[10] = z[2]; out[11] = 0;
  out[12] = -dot3(x, eye);
  out[13] = -dot3(y, eye);
  out[14] = -dot3(z, eye);
  out[15] = 1;
  return out;
}

function perspectiveFovLH(out, fov, aspect, near, far) {
  out.fill(0);
  // D3DX stores half-FOV, sin, cos and each quotient to float32 in this order.
  const halfFov = Math.fround(fov * 0.5);
  const sine = Math.fround(Math.sin(halfFov));
  const cosine = Math.fround(Math.cos(halfFov));
  const yScale = Math.fround(cosine / sine);
  const zScale = Math.fround(far / Math.fround(far - near));
  out[0] = Math.fround(yScale / aspect);
  out[5] = yScale;
  out[10] = zScale;
  out[11] = 1;
  out[14] = Math.fround(-near * zScale);
  return out;
}

function multiplyMatrix(out, a, b) {
  const result = out === a || out === b ? new Float32Array(16) : out;
  for (let row = 0; row < 4; ++row) {
    for (let column = 0; column < 4; ++column) {
      const p0 = Math.fround(a[row * 4] * b[column]);
      const p1 = Math.fround(a[row * 4 + 1] * b[4 + column]);
      const p2 = Math.fround(a[row * 4 + 2] * b[8 + column]);
      const p3 = Math.fround(a[row * 4 + 3] * b[12 + column]);
      // This is the exact add grouping used by d3dx9_33's SSE dispatch path.
      result[row * 4 + column] = row === 0 || row === 3
        ? Math.fround(Math.fround(p0 + p1) + Math.fround(p2 + p3))
        : Math.fround(Math.fround(Math.fround(p0 + p1) + p2) + p3);
    }
  }
  if (result !== out) out.set(result);
  return out;
}

function copyVec4(a) {
  return [a[0], a[1], a[2], a[3]];
}

function multiplyVec4(a, b) {
  return [
    Math.fround(a[0] * b[0]), Math.fround(a[1] * b[1]),
    Math.fround(a[2] * b[2]), Math.fround(a[3] * b[3]),
  ];
}

function addVec4(a, b) {
  return [
    Math.fround(a[0] + b[0]), Math.fround(a[1] + b[1]),
    Math.fround(a[2] + b[2]), Math.fround(a[3] + b[3]),
  ];
}

function subtractVec4(a, b) {
  return [
    Math.fround(a[0] - b[0]), Math.fround(a[1] - b[1]),
    Math.fround(a[2] - b[2]), Math.fround(a[3] - b[3]),
  ];
}

function shuffleVec4(a, b, control) {
  return [
    a[control & 3],
    a[(control >> 2) & 3],
    b[(control >> 4) & 3],
    b[(control >> 6) & 3],
  ];
}

function permuteVec4(a, control) {
  return shuffleVec4(a, a, control);
}

/**
 * Recreates the SSE implementation selected by D3DXMatrixInverse on an
 * SSE2-capable machine with the official d3dx9_33 runtime. The temporary order
 * mirrors its mulps/addps/subps/shufps sequence; a double-precision cofactor
 * inverse moves the reconstructed world rays enough to be measurable.
 */
function invertMatrix(out, a) {
  let x2 = [a[2], a[3], a[6], a[7]];
  let x4 = [a[10], a[11], a[14], a[15]];
  let x3 = [a[8], a[9], a[12], a[13]];
  let x1 = [a[0], a[1], a[4], a[5]];
  let x5 = copyVec4(x2);
  let x6;
  let x7;

  x5 = shuffleVec4(x5, x4, 0x88);
  x4 = shuffleVec4(x4, x2, 0xdd);
  x2 = multiplyVec4(x4, x5);
  x2 = permuteVec4(x2, 0xb1);
  x6 = permuteVec4(x2, 0x4e);
  x7 = copyVec4(x3);
  x3 = shuffleVec4(x3, x1, 0xdd);
  x1 = shuffleVec4(x1, x7, 0x88);
  x7 = copyVec4(x3);
  x3 = multiplyVec4(x3, x6);
  x6 = multiplyVec4(x6, x1);
  const stack208 = copyVec4(x6);
  x6 = copyVec4(x7);
  x7 = multiplyVec4(x7, x2);
  x2 = multiplyVec4(x2, x1);
  x3 = subtractVec4(x3, x7);
  x7 = multiplyVec4(x6, x5);
  x5 = permuteVec4(x5, 0x4e);
  x7 = permuteVec4(x7, 0xb1);
  const stack192 = copyVec4(x2);
  x2 = addVec4(multiplyVec4(x4, x7), x3);
  x3 = multiplyVec4(x7, x1);
  const stack176 = copyVec4(x3);
  x7 = permuteVec4(x7, 0x4e);
  x3 = multiplyVec4(x4, x7);
  x7 = multiplyVec4(x7, x1);
  x2 = subtractVec4(x2, x3);
  x3 = permuteVec4(x6, 0x4e);
  x3 = permuteVec4(multiplyVec4(x3, x4), 0xb1);
  const stack160 = copyVec4(x7);
  x7 = copyVec4(x5);
  x5 = addVec4(multiplyVec4(x5, x3), x2);
  x2 = multiplyVec4(x3, x1);
  x3 = permuteVec4(x3, 0x4e);
  const stack144 = copyVec4(x4);
  x4 = copyVec4(x7);
  x7 = multiplyVec4(x7, x3);
  x3 = multiplyVec4(x3, x1);
  x5 = subtractVec4(x5, x7);
  x3 = subtractVec4(x3, x2);
  x2 = copyVec4(x1);
  x1 = multiplyVec4(x1, x5);
  x3 = permuteVec4(x3, 0x4e);
  x7 = copyVec4(x1);
  x1 = permuteVec4(x1, 0x4e);
  const stack224 = copyVec4(x5);
  x1 = addVec4(x1, x7);
  x5 = copyVec4(x1);
  x1 = permuteVec4(x1, 0xb1);
  x1[0] = Math.fround(x1[0] + x5[0]);

  x5 = permuteVec4(multiplyVec4(x6, x2), 0xb1);
  x7 = copyVec4(x5);
  x5 = permuteVec4(x5, 0x4e);
  const stack128 = copyVec4(x4);
  x4 = copyVec4(stack144);
  const stack112 = copyVec4(x6);
  x6 = addVec4(multiplyVec4(x4, x7), x3);
  x3 = subtractVec4(multiplyVec4(x4, x5), x6);
  x6 = permuteVec4(multiplyVec4(x4, x2), 0xb1);
  const stack96 = copyVec4(x5);
  x5 = copyVec4(stack112);
  const stack80 = copyVec4(x7);
  x7 = addVec4(multiplyVec4(x6, x5), x3);
  x3 = permuteVec4(x6, 0x4e);
  const stack64 = copyVec4(x4);
  x4 = copyVec4(x5);
  x5 = multiplyVec4(x5, x3);
  const stack48 = copyVec4(x4);
  x4 = copyVec4(x6);
  x6 = subtractVec4(x7, x5);
  x5 = permuteVec4(subtractVec4(stack208, stack192), 0x4e);
  x7 = copyVec4(stack128);
  x4 = multiplyVec4(x4, x7);
  x3 = multiplyVec4(x3, x7);
  x5 = subtractVec4(x5, x4);
  x2 = multiplyVec4(x2, x7);
  x3 = addVec4(x3, x5);
  x2 = permuteVec4(x2, 0xb1);
  x4 = permuteVec4(x2, 0x4e);
  x5 = copyVec4(stack64);
  const stack32 = copyVec4(x6);
  x6 = multiplyVec4(x5, x4);
  x5 = addVec4(multiplyVec4(x5, x2), x3);
  x3 = copyVec4(x4);
  x4 = subtractVec4(x5, x6);
  x5 = permuteVec4(subtractVec4(stack160, stack176), 0x4e);
  x6 = multiplyVec4(stack80, x7);
  x6 = subtractVec4(x6, x5);
  x7 = multiplyVec4(x7, stack96);
  x6 = subtractVec4(x6, x7);
  x5 = copyVec4(stack48);
  x2 = multiplyVec4(x2, x5);
  x5 = multiplyVec4(x5, x3);
  x6 = subtractVec4(x6, x2);
  x2 = addVec4(x5, x6);

  const determinant = x1[0];
  if (!determinant) throw new Error('Camera matrix is singular');
  // D3DX uses rcpss and one Newton step. An accurately rounded seed reaches
  // the same converged float32 reciprocal for the intro's camera matrices.
  let reciprocal = Math.fround(1 / determinant);
  reciprocal = Math.fround(
    Math.fround(reciprocal + reciprocal)
      - Math.fround(determinant * Math.fround(reciprocal * reciprocal)),
  );
  const scale = [reciprocal, reciprocal, reciprocal, reciprocal];
  out.set(multiplyVec4(stack224, scale), 0);
  out.set(multiplyVec4(x4, scale), 4);
  out.set(multiplyVec4(stack32, scale), 8);
  out.set(multiplyVec4(x2, scale), 12);
  return out;
}

export const rendererFidelityInternals = Object.freeze({
  lookAtLH,
  perspectiveFovLH,
  multiplyMatrix,
  invertMatrix,
});

function firstValue(object, names) {
  for (const name of names) {
    if (object[name] !== undefined) return object[name];
  }
  return undefined;
}

function assignIfDefined(target, index, value, transform = (x) => x) {
  if (value !== undefined) target[index] = Math.fround(transform(Number(value)));
}

/**
 * Faithful WebGL2 rendering pipeline for Elevated.
 *
 * `render(samplePosition, frame, instrumentSync)` accepts either:
 *
 * - normalized `frame.sync` values named camSeedX, camSeedY, camSpeed,
 *   camFov, camPosY, camTarY, sunAngle, waterLevel, season, brightness,
 *   contrast and terrainScale; or
 * - the original Rocket track values/names with `frame.rawSync = true`.
 *   Objects containing terWaterLevel/imgBrightness/terScale are detected as
 *   raw automatically.
 *
 * `frame.instrumentSync` (or the third argument) is eight sample-age values.
 * When omitted, the renderer derives them from the original sequence/pattern.
 */
export class Renderer {
  constructor(canvasOrContext, options = {}) {
    const contextAttributes = {
      alpha: false,
      antialias: false,
      depth: true,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
      ...options.contextAttributes,
    };

    const suppliedContext = canvasOrContext && typeof canvasOrContext.createShader === 'function';
    const canvas = suppliedContext ? canvasOrContext.canvas : canvasOrContext;
    const gl = suppliedContext ? canvasOrContext : canvas?.getContext?.('webgl2', contextAttributes);
    if (!gl) throw new Error('Elevated requires WebGL2');
    if (!canvas || !('width' in canvas) || !('height' in canvas)) {
      throw new Error('Elevated requires a resizable WebGL canvas');
    }
    if (!gl.getExtension('EXT_color_buffer_float')) {
      throw new Error('Elevated requires EXT_color_buffer_float for its RGBA32F camera/G-buffer');
    }

    this.gl = gl;
    this.canvas = canvas;
    const viewportLimits = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
    const textureLimit = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    const renderbufferLimit = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE);
    this.maxRenderWidth = Math.min(textureLimit, renderbufferLimit, viewportLimits[0]);
    this.maxRenderHeight = Math.min(textureLimit, renderbufferLimit, viewportLimits[1]);
    const initialSize = fitRenderSizeWithinLimits(
      options.width ?? RENDER_WIDTH,
      options.height ?? RENDER_HEIGHT,
      this.maxRenderWidth,
      this.maxRenderHeight,
    );
    this.width = initialSize.width;
    this.height = initialSize.height;
    canvas.width = this.width;
    canvas.height = this.height;
    this.width = gl.drawingBufferWidth;
    this.height = gl.drawingBufferHeight;

    this.q = new Float32Array(64);
    this.q.set(DEFAULT_Q);
    this.currentMatrix = new Float32Array(16);
    this.inverseMatrix = new Float32Array(16);
    this.futureMatrix = new Float32Array(16);
    this.viewMatrix = new Float32Array(16);
    this.projectionMatrix = new Float32Array(16);
    this.cameraPixels = new Float32Array(8);

    this.programs = {
      camera: createProgram(gl, fullscreenVertexShader, cameraFragmentShader, 'camera/m1'),
      terrain: createProgram(gl, terrainVertexShader, terrainFragmentShader, 'terrain/m0+m2'),
      color: createProgram(gl, fullscreenVertexShader, colorFragmentShader, 'lighting/m3'),
      post: createProgram(gl, fullscreenVertexShader, postFragmentShader, 'post/m4'),
    };

    this.fullscreenVao = gl.createVertexArray();
    const mesh = createTerrainMeshData(options.tessellation ?? 1024);
    this.terrainIndexCount = mesh.indices.length;
    this.terrainVao = gl.createVertexArray();
    this.terrainVertexBuffer = gl.createBuffer();
    this.terrainIndexBuffer = gl.createBuffer();
    gl.bindVertexArray(this.terrainVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.terrainVertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.terrainIndexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);

    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    this.noiseTexture = createTexture(gl, {
      width: NOISE_SIZE,
      height: NOISE_SIZE,
      internalFormat: gl.R16F,
      format: gl.RED,
      type: gl.FLOAT,
      data: createNoiseData(options.noiseSeed ?? NOISE_SEED),
      wrap: gl.REPEAT,
      label: 'noise texture',
    });
    this.cameraTexture = createTexture(gl, {
      width: 2,
      height: 1,
      internalFormat: gl.RGBA32F,
      format: gl.RGBA,
      type: gl.FLOAT,
      wrap: gl.CLAMP_TO_EDGE,
      label: '2x1 camera texture',
    });

    Object.assign(this, createRenderTargets(gl, this.width, this.height));
    this.cameraFramebuffer = createFramebuffer(gl, this.cameraTexture, null, '2x1 camera target');

    // D3D9 device defaults used by the intro. In particular WebGL defaults to
    // dithering, while D3DRS_DITHERENABLE defaults to false.
    gl.disable(gl.BLEND);
    gl.disable(gl.DITHER);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.depthFunc(gl.LEQUAL);
    // D3D9's default D3DRS_CULLMODE is D3DCULL_CCW: counter-clockwise
    // triangles are discarded, so clockwise triangles are the front faces.
    gl.frontFace(gl.CW);
    gl.cullFace(gl.BACK);
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1);
    gl.colorMask(true, true, true, true);

    for (const info of Object.values(this.programs)) {
      gl.useProgram(info.program);
      if (info.noise !== null) gl.uniform1i(info.noise, 0);
      if (info.data !== null) gl.uniform1i(info.data, 1);
      if (info.color !== null) gl.uniform1i(info.color, 2);
      if (info.resolution !== null) gl.uniform2f(info.resolution, this.width, this.height);
    }
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** Reallocates full-frame attachments and reports whether the size changed. */
  resize(width, height) {
    const gl = this.gl;
    const targetSize = fitRenderSizeWithinLimits(
      width,
      height,
      this.maxRenderWidth,
      this.maxRenderHeight,
    );
    if (gl.isContextLost()) throw new Error('Unable to resize a lost WebGL context');
    if (targetSize.width === this.width && targetSize.height === this.height) return false;

    discardPendingGlErrors(gl);
    const nextTargets = createRenderTargets(gl, targetSize.width, targetSize.height);
    const previousCanvasWidth = this.canvas.width;
    const previousCanvasHeight = this.canvas.height;
    try {
      this.canvas.width = targetSize.width;
      this.canvas.height = targetSize.height;
      if (
        gl.drawingBufferWidth !== targetSize.width
        || gl.drawingBufferHeight !== targetSize.height
      ) {
        throw new Error(`Unable to create a ${targetSize.width}x${targetSize.height} drawing buffer`);
      }
    } catch (error) {
      deleteRenderTargets(gl, nextTargets);
      this.canvas.width = previousCanvasWidth;
      this.canvas.height = previousCanvasHeight;
      throw error;
    }

    const previousTargets = {
      gBufferTexture: this.gBufferTexture,
      colorTexture: this.colorTexture,
      depthBuffer: this.depthBuffer,
      gBufferFramebuffer: this.gBufferFramebuffer,
      colorFramebuffer: this.colorFramebuffer,
    };
    this.width = targetSize.width;
    this.height = targetSize.height;
    Object.assign(this, nextTargets);
    deleteRenderTargets(gl, previousTargets);
    return true;
  }

  _upload(info, matrix = null) {
    const gl = this.gl;
    gl.useProgram(info.program);
    // A linker may trim q[16] to (for example) q[4] in the terrain program.
    // WebGL rejects an upload larger than the active array, unlike D3D's
    // SetPixelShaderConstantF call, so upload precisely what survived linking.
    if (info.q !== null && info.qVectors > 0) {
      gl.uniform4fv(info.q, this.q, 0, info.qVectors * 4);
    }
    if (matrix && info.v !== null) gl.uniformMatrix4fv(info.v, false, matrix);
    if (info.resolution !== null) gl.uniform2f(info.resolution, this.width, this.height);
  }

  _setSync(frame) {
    const values = frame?.sync ?? frame?.params ?? frame;
    if (!values) return;

    if (ArrayBuffer.isView(values) || Array.isArray(values)) {
      const count = Math.min(12, values.length);
      if (frame?.rawSync) {
        const raw = values;
        const transforms = [
          (x) => x / 256, (x) => x / 256, (x) => x / 4096, (x) => x / 96,
          (x) => x / 64, (x) => (x - 128) / 4, (x) => x / 32,
          (x) => (x - 192) / 128, (x) => x / 256,
          (x) => (x - 128) / 128, (x) => x / 128,
          (x) => (x - 128) / 128,
        ];
        for (let i = 0; i < count; ++i) this.q[i] = Math.fround(transforms[i](raw[i]));
      } else {
        for (let i = 0; i < count; ++i) this.q[i] = Math.fround(values[i]);
      }
      return;
    }

    const rawDetected = 'terWaterLevel' in values
      || 'terSeason' in values
      || 'imgBrightness' in values
      || 'imgContrast' in values
      || 'terScale' in values;
    const raw = frame?.rawSync ?? values.rawSync ?? rawDetected;

    if (raw) {
      assignIfDefined(this.q, 0, firstValue(values, ['camSeedX']), (x) => x / 256);
      assignIfDefined(this.q, 1, firstValue(values, ['camSeedY']), (x) => x / 256);
      assignIfDefined(this.q, 2, firstValue(values, ['camSpeed']), (x) => x / 4096);
      assignIfDefined(this.q, 3, firstValue(values, ['camFov']), (x) => x / 96);
      assignIfDefined(this.q, 4, firstValue(values, ['camPosY']), (x) => x / 64);
      assignIfDefined(this.q, 5, firstValue(values, ['camTarY']), (x) => (x - 128) / 4);
      assignIfDefined(this.q, 6, firstValue(values, ['sun_angle', 'sunAngle']), (x) => x / 32);
      assignIfDefined(this.q, 7, firstValue(values, ['terWaterLevel', 'waterLevel']),
                      (x) => (x - 192) / 128);
      assignIfDefined(this.q, 8, firstValue(values, ['terSeason', 'season']), (x) => x / 256);
      assignIfDefined(this.q, 9, firstValue(values, ['imgBrightness', 'brightness']),
                      (x) => (x - 128) / 128);
      assignIfDefined(this.q, 10, firstValue(values, ['imgContrast', 'contrast']),
                      (x) => x / 128);
      assignIfDefined(this.q, 11, firstValue(values, ['terScale', 'terrainScale']),
                      (x) => (x - 128) / 128);
    } else {
      assignIfDefined(this.q, 0, firstValue(values, ['camSeedX']));
      assignIfDefined(this.q, 1, firstValue(values, ['camSeedY']));
      assignIfDefined(this.q, 2, firstValue(values, ['camSpeed']));
      assignIfDefined(this.q, 3, firstValue(values, ['camFov']));
      assignIfDefined(this.q, 4, firstValue(values, ['camPosY']));
      assignIfDefined(this.q, 5, firstValue(values, ['camTarY']));
      assignIfDefined(this.q, 6, firstValue(values, ['sunAngle', 'sun_angle']));
      assignIfDefined(this.q, 7, firstValue(values, ['waterLevel', 'terWaterLevel']));
      assignIfDefined(this.q, 8, firstValue(values, ['season', 'terSeason']));
      assignIfDefined(this.q, 9, firstValue(values, ['brightness', 'imgBrightness']));
      assignIfDefined(this.q, 10, firstValue(values, ['contrast', 'imgContrast']));
      assignIfDefined(this.q, 11, firstValue(values, ['terrainScale', 'terScale']));
    }
  }

  _setInstrumentSync(samplePosition, provided) {
    // Release clears all q[5]..q[12] components to the current position. Only
    // x is consumed, but retaining this layout makes constant dumps comparable.
    for (let i = 20; i < 52; ++i) this.q[i] = samplePosition;

    if (provided) {
      for (let i = 0; i < 8; ++i) {
        if (provided[i] !== undefined) this.q[20 + i * 4] = Math.fround(provided[i]);
      }
      return;
    }

    let age = samplePosition;
    for (let row = 0; age >= 0; ++row, age -= MAX_NOTE_SAMPLES) {
      const pattern = sequenceData[NUM_ROWS * 2 + (row >> 4)];
      const note = patternData[(pattern << 4) | (row & 15)];
      if (note) this.q[20 + (note & 7) * 4] = age;
    }
  }

  _setFrameConstants(samplePosition, frame, instrumentSync) {
    this._setSync(frame);
    const angle = this.q[6];
    this.q[12] = Math.fround(Math.cos(angle));
    this.q[13] = 0.3125;
    this.q[14] = Math.fround(Math.sin(angle));
    this.q[15] = Math.fround(samplePosition / SAMPLE_RATE);
    const suppliedInstruments = instrumentSync
      ?? frame?.instrumentSync
      ?? frame?.instrumentAges
      ?? frame?.beams;
    this._setInstrumentSync(samplePosition, suppliedInstruments);
  }

  _constructCameraMatrix(out) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.cameraFramebuffer);
    gl.viewport(0, 0, 2, 1);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    this._upload(this.programs.camera);
    bindTexture(gl, 0, this.noiseTexture);
    gl.bindVertexArray(this.fullscreenVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.readPixels(0, 0, 2, 1, gl.RGBA, gl.FLOAT, this.cameraPixels);

    this.q[16] = this.cameraPixels[0];
    this.q[17] = this.cameraPixels[1];
    this.q[18] = this.cameraPixels[2];
    this.q[19] = this.cameraPixels[3];

    const eye = this.cameraPixels;
    const target = this.cameraPixels.subarray(4, 7);
    const roll = this.cameraPixels[3];
    // The release stores both x87 fsincos results to float32 before D3DX.
    const up = [Math.fround(Math.sin(roll)), Math.fround(Math.cos(roll)), 0];
    lookAtLH(this.viewMatrix, eye, target, up);
    perspectiveFovLH(
      this.projectionMatrix,
      this.q[3],
      RELEASE_PROJECTION_ASPECT,
      CAMERA_NEAR,
      CAMERA_FAR,
    );
    multiplyMatrix(out, this.viewMatrix, this.projectionMatrix);
  }

  /** Render one visual frame at an integer position in the 44.1 kHz source. */
  render(samplePosition, frame = {}, instrumentSync = null) {
    const gl = this.gl;
    const position = Math.max(0, Math.floor(Number(samplePosition) || 0));
    this._setFrameConstants(position, frame, instrumentSync);

    // m1: GPU camera/target generation followed by D3DX-style CPU matrices.
    this._constructCameraMatrix(this.currentMatrix);

    // m0+m2: displaced terrain into the floating-point world-position buffer.
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.gBufferFramebuffer);
    gl.viewport(0, 0, this.width, this.height);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.enable(gl.CULL_FACE);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    this._upload(this.programs.terrain, this.currentMatrix);
    bindTexture(gl, 0, this.noiseTexture);
    gl.bindVertexArray(this.terrainVao);
    gl.drawElements(gl.TRIANGLES, this.terrainIndexCount, gl.UNSIGNED_INT, 0);

    // m3: inverse current camera, procedural lighting, RGBA8 quantization.
    invertMatrix(this.inverseMatrix, this.currentMatrix);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.colorFramebuffer);
    gl.viewport(0, 0, this.width, this.height);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    this._upload(this.programs.color, this.inverseMatrix);
    bindTexture(gl, 0, this.noiseTexture);
    bindTexture(gl, 1, this.gBufferTexture);
    gl.bindVertexArray(this.fullscreenVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // The release assembly advances only q.time, by its deliberately truncated
    // float, then regenerates the camera used to project motion vectors.
    this.q[15] = Math.fround(this.q[15] + RELEASE_SHUTTER_SECONDS);
    this._constructCameraMatrix(this.futureMatrix);

    // m4: 16-tap motion blur, tonemap, vignette, flicker and grain.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    this._upload(this.programs.post, this.futureMatrix);
    bindTexture(gl, 0, this.noiseTexture);
    bindTexture(gl, 1, this.gBufferTexture);
    bindTexture(gl, 2, this.colorTexture);
    gl.bindVertexArray(this.fullscreenVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    return this;
  }

  dispose() {
    const gl = this.gl;
    for (const info of Object.values(this.programs)) gl.deleteProgram(info.program);
    gl.deleteVertexArray(this.fullscreenVao);
    gl.deleteVertexArray(this.terrainVao);
    gl.deleteBuffer(this.terrainVertexBuffer);
    gl.deleteBuffer(this.terrainIndexBuffer);
    deleteRenderTargets(gl, this);
    gl.deleteFramebuffer(this.cameraFramebuffer);
    gl.deleteTexture(this.noiseTexture);
    gl.deleteTexture(this.cameraTexture);
  }
}

export function createRenderer(canvasOrContext, options) {
  return new Renderer(canvasOrContext, options);
}
