/**
 * Target of the `three` → `three/webgpu` alias. The WebGPU build drops the
 * WebGL-only uniform helpers, but @pixiv/three-vrm's main bundle still
 * references them for its WebGL MToonMaterial (never instantiated here — the
 * loader is configured with MToonNodeMaterial). Re-export them from three's
 * source so the bundler's static export check passes.
 */

export { UniformsLib } from "three/src/renderers/shaders/UniformsLib.js";
export { UniformsUtils } from "three/src/renderers/shaders/UniformsUtils.js";
export * from "three/webgpu";
