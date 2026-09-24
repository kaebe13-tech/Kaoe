import { Vector3, type IUniform, type Material, type WebGLProgramParametersWithUniforms } from 'three';

/** Shared uniforms: where the camera is looking (the focus) and how aggressively to cut away. */
export const seeThroughUniforms = {
  uFocus: { value: new Vector3() } as IUniform<Vector3>,
  uCutRadius: { value: 1.6 } as IUniform<number>,
  uNearFade: { value: 3.5 } as IUniform<number>,
};

const PARS = /* glsl */ `
uniform vec3 uFocus;
uniform float uCutRadius;
uniform float uNearFade;
varying vec3 vSeeWorld;
float seeDither(vec2 p) {
  // 4x4 Bayer matrix for a stable screen-door pattern.
  vec2 q = mod(floor(p), 4.0);
  float i = q.x + q.y * 4.0;
  float b = 0.0;
  if (i < 0.5) b = 0.0; else if (i < 1.5) b = 8.0; else if (i < 2.5) b = 2.0; else if (i < 3.5) b = 10.0;
  else if (i < 4.5) b = 12.0; else if (i < 5.5) b = 4.0; else if (i < 6.5) b = 14.0; else if (i < 7.5) b = 6.0;
  else if (i < 8.5) b = 3.0; else if (i < 9.5) b = 11.0; else if (i < 10.5) b = 1.0; else if (i < 11.5) b = 9.0;
  else if (i < 12.5) b = 15.0; else if (i < 13.5) b = 7.0; else if (i < 14.5) b = 13.0; else b = 5.0;
  return (b + 0.5) / 16.0;
}
`;

const FRAG = /* glsl */ `
{
  vec3 toFrag = vSeeWorld - cameraPosition;
  float camDist = length(toFrag);
  float fade = 1.0 - smoothstep(uNearFade * 0.55, uNearFade, camDist);
  vec3 axis = uFocus - cameraPosition;
  float axisLen = length(axis);
  if (axisLen > 0.001 && uCutRadius > 0.0) {
    vec3 dir = axis / axisLen;
    float t = dot(toFrag, dir);
    if (t > 0.0 && t < axisLen - 0.8) {
      float off = length(toFrag - dir * t);
      float r = uCutRadius * (0.6 + 0.4 * t / axisLen);
      fade = max(fade, (1.0 - smoothstep(r * 0.6, r, off)) * smoothstep(0.0, 2.0, axisLen - t));
    }
  }
  if (fade > 0.0 && seeDither(gl_FragCoord.xy) < fade * 0.85) discard;
}
`;

/**
 * Patch a material so fragments very close to the camera, or between the camera and the
 * focus point, are dithered away — the followed human never disappears behind a canopy.
 */
export function applySeeThrough(mat: Material, key: string): void {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms, renderer) => {
    prev.call(mat, shader, renderer);
    Object.assign(shader.uniforms, seeThroughUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSeeWorld;')
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
{
  vec4 swp = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    swp = instanceMatrix * swp;
  #endif
  vSeeWorld = (modelMatrix * swp).xyz;
}`,
      );
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>\n${PARS}`).replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\n${FRAG}`);
  };
  const prevKey = mat.customProgramCacheKey.bind(mat);
  mat.customProgramCacheKey = () => `${prevKey()}-see-${key}`;
}
