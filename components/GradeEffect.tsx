import { BlendFunction, Effect } from "postprocessing";
import * as THREE from "three";

// Filmic color grade, applied AFTER tone mapping (display-referred 0..1).
// Replaces the old BrightnessContrast + HueSaturation pair, which ran on
// linear HDR before tone mapping: its contrast pivot (0.5 linear, ~sRGB 0.73)
// pushed every dark pixel below zero and crushed night scenes to black,
// HueSaturation clamped all highlights to 1.0 before the tone curve ever saw
// them, and strongly saturated sunset colors came out negative and turned
// into NaN blocks in the bloom. Here everything happens in a perceptual
// (gamma 2) space and stays inside [0, 1]:
//   - S-curve contrast around perceptual mid-gray,
//   - vibrance: lifts muted colors more than already saturated ones,
//   - split-tone: cool shadows, warm highlights (tinted by time of day).
const GRADE_FRAGMENT = /* glsl */ `
  uniform float contrast;
  uniform float saturation;
  uniform float vibrance;
  uniform vec3 shadowTint;
  uniform vec3 highlightTint;

  void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
    vec3 p = sqrt(clamp(inputColor.rgb, 0.0, 1.0));
    p = mix(p, p * p * (3.0 - 2.0 * p), contrast);
    float l = dot(p, vec3(0.2126, 0.7152, 0.0722));
    float chroma = max(max(p.r, p.g), p.b) - min(min(p.r, p.g), p.b);
    p = mix(vec3(l), p, 1.0 + saturation + vibrance * (1.0 - chroma));
    float shadow = (1.0 - l) * (1.0 - l);
    p += shadowTint * shadow;
    p *= mix(vec3(1.0), highlightTint, l * l);
    p = clamp(p, 0.0, 1.0);
    outputColor = vec4(p * p, inputColor.a);
  }
`;

export class GradeEffectImpl extends Effect {
  constructor() {
    super("GradeEffect", GRADE_FRAGMENT, {
      blendFunction: BlendFunction.SRC,
      uniforms: new Map<string, THREE.Uniform>([
        ["contrast", new THREE.Uniform(0)],
        ["saturation", new THREE.Uniform(0)],
        ["vibrance", new THREE.Uniform(0)],
        ["shadowTint", new THREE.Uniform(new THREE.Vector3())],
        ["highlightTint", new THREE.Uniform(new THREE.Vector3(1, 1, 1))],
      ]),
    });
  }
}

export type GradeSettings = {
  contrast: number;
  saturation: number;
  vibrance: number;
  shadowTint: [number, number, number];
  highlightTint: [number, number, number];
};

// Uniform updates never rebuild the effect, so the grade can follow the time
// of day for free (EffectComposer recompiles only on a new child list).
export function applyGrade(effect: GradeEffectImpl, g: GradeSettings): void {
  const u = effect.uniforms;
  u.get("contrast")!.value = g.contrast;
  u.get("saturation")!.value = g.saturation;
  u.get("vibrance")!.value = g.vibrance;
  (u.get("shadowTint")!.value as THREE.Vector3).set(...g.shadowTint);
  (u.get("highlightTint")!.value as THREE.Vector3).set(...g.highlightTint);
}
