import { BackSide, Color, Mesh, ShaderMaterial, SphereGeometry, Vector3 } from 'three';

const vert = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}
`;

const frag = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGround;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunVis;
uniform vec3 uMoonDir;
uniform float uStarVis;
uniform float uTime;
uniform float uCloudy;
varying vec3 vDir;

float sHash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

void main() {
  vec3 d = normalize(vDir);
  float y = d.y;
  vec3 col = mix(uHorizon, uZenith, pow(clamp(y, 0.0, 1.0), 0.5));
  col = mix(col, uGround, smoothstep(0.0, -0.3, y));

  float sd = max(dot(d, uSunDir), 0.0);
  col += uSunColor * (pow(sd, 6.0) * 0.22 + pow(sd, 48.0) * 0.45) * uSunVis * (1.0 - uCloudy * 0.7);
  col += uSunColor * smoothstep(0.9985, 0.9992, sd) * 1.6 * uSunVis * (1.0 - uCloudy);

  float md = max(dot(d, uMoonDir), 0.0);
  col += vec3(0.92, 0.95, 1.0) * smoothstep(0.99935, 0.9996, md) * uStarVis * (1.0 - uCloudy);
  col += vec3(0.35, 0.45, 0.75) * pow(md, 24.0) * 0.18 * uStarVis;

  vec3 sp = d * 150.0;
  vec3 cell = floor(sp);
  float h = sHash(cell);
  vec3 f = fract(sp) - 0.5;
  float star = step(0.975, h) * smoothstep(0.22, 0.0, length(f));
  float tw = 0.65 + 0.35 * sin(uTime * (1.5 + h * 3.0) + h * 40.0);
  col += vec3(1.0, 0.97, 0.9) * star * tw * uStarVis * smoothstep(0.02, 0.25, y) * (1.0 - uCloudy);

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class SkyView {
  readonly mesh: Mesh;
  readonly material: ShaderMaterial;

  constructor() {
    this.material = new ShaderMaterial({
      uniforms: {
        uZenith: { value: new Color(0x5aa9e6) },
        uHorizon: { value: new Color(0xbfe3f5) },
        uGround: { value: new Color(0x2a6f8a) },
        uSunDir: { value: new Vector3(0, 1, 0) },
        uSunColor: { value: new Color(0xffffff) },
        uSunVis: { value: 1 },
        uMoonDir: { value: new Vector3(0, -1, 0) },
        uStarVis: { value: 0 },
        uTime: { value: 0 },
        uCloudy: { value: 0 },
      },
      vertexShader: vert,
      fragmentShader: frag,
      side: BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
    });
    this.mesh = new Mesh(new SphereGeometry(1000, 32, 16), this.material);
    this.mesh.renderOrder = -1000;
    this.mesh.frustumCulled = false;
    this.mesh.name = 'sky';
  }
}
