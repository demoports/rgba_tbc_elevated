// GLSL ES 3.00 translation of the single HLSL "ubershader" in src/idata.cpp.
//
// The original compiles five entry points from that source: m0 is the terrain
// vertex shader and m1..m4 are the camera, G-buffer, lighting and post shaders.
// These strings intentionally retain the original arithmetic and odd constants.

export const fullscreenVertexShader = `#version 300 es
precision highp float;

void main() {
  // One oversized triangle. Fragment shaders derive the D3D9 TEXCOORD value
  // from gl_FragCoord, so the primitive's interpolants cannot add a half-pixel.
  const vec2 positions[3] = vec2[3](
    vec2(-1.0, -1.0),
    vec2( 3.0, -1.0),
    vec2(-1.0,  3.0)
  );
  gl_Position = vec4(positions[gl_VertexID], 0.0, 1.0);
}
`;

// sampler2D defaults to lowp in GLSL ES. The HLSL samples full-float terrain
// data, so keep every sampler explicit for mobile GPUs that honor precision.
const uniforms = `
uniform highp sampler2D uNoise;
uniform vec4 q[16];
uniform mat4 v;
`;

// HLSL's saturate and smoothstep are used explicitly. GLSL leaves reversed
// smoothstep edges undefined, while m3 deliberately calls smoothstep(1, 0, x).
const terrainFunctions = `
float sat(float x) { return clamp(x, 0.0, 1.0); }

float hSmoothstep(float edge0, float edge1, float x) {
  float t = clamp((x - edge0) / (edge1 - edge0), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

// Value noise plus analytic derivative (the original function "no").
vec3 noiseD(vec2 p) {
  vec2 cell = floor(p);
  vec2 local = p - cell;
  vec2 u = local * local * local * (local * (local * 6.0 - 15.0) + 10.0);

  float a = textureLod(uNoise, (cell + vec2(0.0, 0.0)) / 256.0, 0.0).r;
  float b = textureLod(uNoise, (cell + vec2(1.0, 0.0)) / 256.0, 0.0).r;
  float c = textureLod(uNoise, (cell + vec2(0.0, 1.0)) / 256.0, 0.0).r;
  float d = textureLod(uNoise, (cell + vec2(1.0, 1.0)) / 256.0, 0.0).r;

  float value = a + (b - a) * u.x + (c - a) * u.y
              + (a - b - c + d) * u.x * u.y;
  vec2 derivative = 30.0 * local * local
                  * (local * (local - 2.0) + 1.0)
                  * (vec2(b - a, c - a) + (a - b - c + d) * u.yx);
  return vec3(value, derivative);
}

// Eroded fBm terrain (the original function "f"). A floating loop bound is
// intentional: HLSL executes ceil(octaves) iterations for positive non-integers.
float terrain(vec2 p, float octaves) {
  vec2 derivative = vec2(0.0);
  float height = 0.0;
  float amplitude = 3.0;
  for (float i = 0.0; i < octaves; i += 1.0) {
    vec3 n = noiseD(0.25 * p);
    derivative += n.yz;
    amplitude *= 0.5;
    height += amplitude * n.x / (1.0 + dot(derivative, derivative));
    p = vec2(1.6 * p.x - 1.2 * p.y,
             1.2 * p.x + 1.6 * p.y);
  }
  return height;
}

vec3 terrainNormal(vec2 p, float epsilon, float octaves) {
  float center = terrain(p, octaves);
  return normalize(vec3(
    q[2].w * (center - terrain(p + vec2(epsilon, 0.0), octaves)),
    epsilon,
    q[2].w * (center - terrain(p + vec2(0.0, epsilon), octaves))
  ));
}

vec3 terrainLight(vec3 position, vec3 normal, vec3 smoothNormal) {
  float sdl = dot(smoothNormal, q[3].xyz);
  float ndl = mix(sdl, dot(normal, q[3].xyz), 0.5 + 0.5 * q[2].x);
  return vec3(0.13, 0.18, 0.22)
       * (normal.y + 0.25 * sat(-ndl) - 0.1 * noiseD(1024.0 * position.xz).y)
       + vec3(1.4, 1.0, 0.7) * sat(ndl) * sat(2.0 * sdl);
}
`;

export const terrainVertexShader = `#version 300 es
precision highp float;
precision highp int;

layout(location = 0) in vec2 aPosition;
out highp vec4 worldPosition;
uniform vec2 uResolution;

${uniforms}
${terrainFunctions}

void main() {
  vec4 position = vec4(aPosition, 0.0, 1.0);
  position.z = q[2].w * terrain(position.yx, 8.0);
  worldPosition = position.yzxw;

  vec4 d3dClip = v * worldPosition;
  // D3D9 clips z to [0,w], WebGL to [-w,w]. The z remap gives exactly the
  // same normalized depth. The x/y adjustment below only aligns sample centres.
  // D3D9 samples at integer pixel centres whereas WebGL samples at half
  // integers. Shift projected geometry by half a pixel so coverage and the
  // interpolated G-buffer positions land at the original sample locations.
  vec2 halfPixel = vec2(d3dClip.w / uResolution.x,
                        -d3dClip.w / uResolution.y);
  gl_Position = vec4(d3dClip.xy + halfPixel,
                     2.0 * d3dClip.z - d3dClip.w,
                     d3dClip.w);
}
`;

export const terrainFragmentShader = `#version 300 es
precision highp float;

in highp vec4 worldPosition;
layout(location = 0) out vec4 fragmentColor;

void main() {
  fragmentColor = worldPosition;
}
`;

export const cameraFragmentShader = `#version 300 es
precision highp float;
precision highp int;

${uniforms}
${terrainFunctions}

layout(location = 0) out vec4 fragmentColor;

void main() {
  // D3D9 VPOS is integer-centred. The 2x1 target therefore supplies x=0 for
  // the camera and x=1 for its target, exactly as m1 expects.
  vec2 x = gl_FragCoord.xy - vec2(0.5);
  vec2 o = q[0].xy + vec2(x.x * 0.37);
  vec3 camera;
  float time = q[3].w * q[0].z;

  o += vec2(0.1); float n0 = textureLod(uNoise, o, 0.0).r;
  o += vec2(0.1); float n1 = textureLod(uNoise, o, 0.0).r;
  o += vec2(0.1); float n2 = textureLod(uNoise, o, 0.0).r;
  o += vec2(0.1); float n3 = textureLod(uNoise, o, 0.0).r;
  camera.x = 16.0 * cos(time * n0 + 3.0 * n1)
           +  8.0 * cos(time * n2 * 2.0 + 3.0 * n3);

  o += vec2(0.1); float n4 = textureLod(uNoise, o, 0.0).r;
  o += vec2(0.1); float n5 = textureLod(uNoise, o, 0.0).r;
  o += vec2(0.1); float n6 = textureLod(uNoise, o, 0.0).r;
  o += vec2(0.1); float n7 = textureLod(uNoise, o, 0.0).r;
  camera.z = 16.0 * cos(time * n4 + 3.0 * n5)
           +  8.0 * cos(time * n6 * 2.0 + 3.0 * n7);

  camera.y = q[2].w * terrain(camera.xz, 3.0) + q[1].x + q[1].y * x.x;

  o += vec2(q[3].w * 0.5);
  o += vec2(0.1); camera.x += 0.002 * noiseD(o).x;
  o += vec2(0.1); camera.y += 0.002 * noiseD(o).x;
  o += vec2(0.1); camera.z += 0.002 * noiseD(o).x;

  fragmentColor = vec4(camera, 0.3 * cos(time * 2.0));
}
`;

const screenFunctions = `
uniform vec2 uResolution;

// D3D9's transformed quad has integer pixel centres and a top-left origin.
vec2 d3dScreenCoord() {
  return vec2(
    (gl_FragCoord.x - 0.5) / uResolution.x,
    (uResolution.y - 0.5 - gl_FragCoord.y) / uResolution.y
  );
}

// Render-to-texture storage is bottom-left in WebGL. Keep all shader math in
// the original top-left convention and convert only at the texture lookup.
vec2 framebufferCoord(vec2 d3dCoord) {
  return vec2(d3dCoord.x, 1.0 - d3dCoord.y);
}
`;

export const colorFragmentShader = `#version 300 es
precision highp float;
precision highp int;

${uniforms}
uniform highp sampler2D uData;
${screenFunctions}
${terrainFunctions}

layout(location = 0) out vec4 fragmentColor;

float hFmod(float a, float b) {
  // HLSL's floating % truncates the quotient rather than using GLSL mod's
  // floor convention. The +1000 in m3 normally keeps this positive anyway.
  return a - trunc(a / b) * b;
}

void main() {
  vec2 x = d3dScreenCoord();
  vec2 o = x + vec2(0.5 / 1280.0);
  vec4 data = texture(uData, framebufferCoord(o));

  // HLSL overload resolution normalizes mul(v, float4(...)) as a float4 and
  // only then truncates it for the float3 assignment.
  vec3 eye = normalize(v * vec4(x.x * 2.0 - 1.0,
                                -x.y * 2.0 + 1.0,
                                1.0, 1.0)).xyz;
  vec2 sky = eye.xz / eye.y;
  float k = hFmod(2.0 * sky.y + 1000.0, 8.0);
  int beamIndex = int(k);
  float beamAge = q[5 + beamIndex].x;

  vec3 color = vec3(0.55, 0.65, 0.75)
             + vec3(0.1 * terrain(sky + vec2(q[3].w * 0.2), 10.0))
             + vec3(0.5 * pow(1.0 - eye.y, 8.0))
             + pow(sat(dot(eye, q[3].xyz)), 16.0) * vec3(0.4, 0.3, 0.1)
             + vec3(1.0 + 0.4 * k, 2.0, 3.0 + 0.5 * k)
             * (1.0 - cos(12.5664 * sky.y))
             * sat(1.0 - abs(sky.y) / 10.0
                       - abs(sky.x + beamAge * 0.0012 - 8.0) / 20.0)
             * exp(-beamAge * 0.0002);

  if (data.w > 0.5) {
    float distanceToCamera = length(data.xyz - q[4].xyz);
    float waterDepth = q[1].w - data.y;

    if (waterDepth < 0.0) {
      vec3 normal = terrainNormal(data.xz, 0.001 * distanceToCamera,
                                  12.0 - log2(distanceToCamera));
      float detailHeight = terrain(3.0 * data.xz, 3.0);
      float randomRock = noiseD(666.0 * data.xz).x;

      color = vec3((0.1 + 0.75 * q[2].x) * (0.8 + 0.2 * randomRock));
      color = mix(
        color,
        mix(vec3(0.8, 0.85, 0.9),
            vec3(0.45, 0.45, 0.2) * (0.8 + 0.2 * randomRock), q[2].x),
        hSmoothstep(0.5 - 0.8 * normal.y,
                    1.0 - 1.1 * normal.y,
                    detailHeight * 0.15)
      );
      color = mix(
        color,
        mix(vec3(0.37, 0.23, 0.08), vec3(0.42, 0.4, 0.2), q[2].x)
          * (0.5 + 0.5 * randomRock),
        hSmoothstep(0.0, 1.0,
                    50.0 * (normal.y - 1.0) + (detailHeight + q[2].x) / 0.4)
      );
      color *= terrainLight(
        data.xyz,
        normal,
        terrainNormal(data.xz, 0.001 * distanceToCamera, 5.0)
      );
    } else {
      distanceToCamera = (q[1].w - q[4].y) / eye.y;
      data = q[4] + vec4(eye.x, eye.y, eye.z, eye.z) * distanceToCamera;

      vec2 waterPosition = vec2(512.0, 32.0) * data.xz
                         + sat(waterDepth * 60.0) * vec2(q[3].w, 0.0);
      vec3 normal = normalize(
        terrainNormal(waterPosition, 0.001 * distanceToCamera, 4.0)
        * vec3(1.0, 6.0, 1.0)
      );

      color = 0.12 * (vec3(0.4, 1.0, 1.0)
             - vec3(0.2, 0.6, 0.4) * sat(waterDepth * 16.0));
      color *= 0.3 + 0.7 * q[2].x;
      color += pow(1.0 - dot(-eye, normal), 4.0)
             // D3D9 ps_3_0 POW evaluates abs(src0)^src1. The reflection dot
             // is commonly negative; GLSL pow is undefined in that case.
             * (pow(abs(dot(q[3].xyz, reflect(-eye, normal))), 32.0)
                * vec3(0.32, 0.31, 0.3) + vec3(0.1));

      float shore = q[2].x + waterDepth * 60.0
                  - terrain(666.0 * data.xz
                    + sat(waterDepth * 60.0) * vec2(q[3].w, 0.0) * 2.0, 5.0);
      color = mix(color, terrainLight(data.xyz, normal, normal),
                  hSmoothstep(1.0, 0.0, shore) * 0.5);
    }

    color *= 0.7 + 0.3 * hSmoothstep(0.0, 1.0, 256.0 * abs(waterDepth));
    color *= exp(-0.042 * distanceToCamera);
    color += (1.0 - exp(-0.1 * distanceToCamera))
           * (vec3(0.52, 0.59, 0.65)
              + pow(sat(dot(eye, q[3].xyz)), 8.0) * vec3(0.6, 0.4, 0.1));
  }

  fragmentColor = vec4(color, 0.0);
}
`;

export const postFragmentShader = `#version 300 es
precision highp float;
precision highp int;

${uniforms}
uniform highp sampler2D uData;
uniform highp sampler2D uColor;
${screenFunctions}

layout(location = 0) out vec4 fragmentColor;

void main() {
  vec2 x = d3dScreenCoord();
  vec2 o = x + vec2(0.5 / 1280.0);
  vec4 data = texture(uData, framebufferCoord(o));
  vec3 color = texture(uColor, framebufferCoord(o)).rgb;

  if (data.w > 0.5) {
    data = v * vec4(data.xyz, 1.0);
    data.y *= -1.0;
    vec2 destination = vec2(0.5) + 0.5 * data.xy / data.w;

    color = vec3(0.0);
    for (int i = 0; i < 16; ++i) {
      vec2 blurCoord = o + float(i) * (destination - o) / 16.0;
      color.r += texture(uColor,
                         framebufferCoord(blurCoord + vec2( 2.0, 0.0) / 1280.0)).r;
      color.g += texture(uColor,
                         framebufferCoord(blurCoord + vec2( 0.0, 0.0) / 1280.0)).g;
      color.b += texture(uColor,
                         framebufferCoord(blurCoord + vec2(-2.0, 0.0) / 1280.0)).b;
    }
    color /= 16.0;
  }

  color = pow(color, vec3(0.45)) * q[2].z + vec3(q[2].y);
  color *= 0.4 + 9.6 * o.x * o.y * (1.0 - o.x) * (1.0 - o.y);
  color.xz *= 0.98;

  float flicker = textureLod(uNoise, vec2(q[3].w * 0.1), 0.0).r;
  o += vec2(flicker);
  color -= vec3(0.005 * flicker);

  o += vec2(0.1); color.r += 0.01 * textureLod(uNoise, o, 0.0).r;
  o += vec2(0.1); color.g += 0.01 * textureLod(uNoise, o, 0.0).r;
  o += vec2(0.1); color.b += 0.01 * textureLod(uNoise, o, 0.0).r;

  fragmentColor = vec4(color, 0.0);
}
`;
