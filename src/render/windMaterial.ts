import { MeshLambertMaterial, type IUniform, type WebGLProgramParametersWithUniforms } from 'three';

export const windUniforms = {
  uWindTime: { value: 0 } as IUniform<number>,
  uWindStrength: { value: 1 } as IUniform<number>,
};

/**
 * Lambert material with vertex-shader wind sway. Sway grows with local height so trunks
 * stay planted; phase varies per instance so a forest never moves in lockstep.
 */
export function windMaterial(opts: { amplitude: number; frequency: number; flatShading?: boolean; key: string }): MeshLambertMaterial {
  const mat = new MeshLambertMaterial({ vertexColors: true, flatShading: opts.flatShading ?? false });
  mat.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    shader.uniforms.uWindTime = windUniforms.uWindTime;
    shader.uniforms.uWindStrength = windUniforms.uWindStrength;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uWindTime;\nuniform float uWindStrength;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
{
  vec3 ip = vec3(0.0);
  #ifdef USE_INSTANCING
    ip = instanceMatrix[3].xyz;
  #endif
  float ph = ip.x * 0.37 + ip.z * 0.23;
  float h = max(position.y, 0.0);
  float k = h * h * ${opts.amplitude.toFixed(4)} * uWindStrength;
  float t = uWindTime * ${opts.frequency.toFixed(3)} + ph;
  transformed.x += (sin(t) * 0.7 + sin(t * 2.3 + 1.7) * 0.3) * k;
  transformed.z += (cos(t * 0.8 + 0.5) * 0.5) * k;
}`,
      );
  };
  mat.customProgramCacheKey = () => `wind-${opts.key}`;
  return mat;
}
