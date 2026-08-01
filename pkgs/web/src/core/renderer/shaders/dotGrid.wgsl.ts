/**
 * Dot Grid Background Shader
 *
 * Draws a screen-space dotted background (note-paper style) shown when the
 * document has no artboards. Dots are placed at a constant on-screen spacing
 * regardless of zoom: the fragment works directly in target (physical) pixels
 * via @builtin(position), so zoom never changes the spacing. The phase anchors
 * the lattice to a caller-supplied screen point (the world origin's projection),
 * so the dots pan with the canvas while keeping constant spacing.
 *
 * Output is premultiplied alpha (paired with a premultiplied-over blend).
 */

export const DOT_GRID_SHADER = /* wgsl */ `
	struct DotGridUniforms {
		spacingPx: f32,
		radiusPx: f32,
		phaseX: f32,
		phaseY: f32,
		colorR: f32,
		colorG: f32,
		colorB: f32,
		colorA: f32,
	};
	@group(0) @binding(0) var<uniform> u: DotGridUniforms;

	@vertex
	fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> @builtin(position) vec4f {
		// Fullscreen triangle (3 vertices, no vertex buffer).
		var positions = array<vec2f, 3>(
			vec2f(-1.0, -1.0),
			vec2f(3.0, -1.0),
			vec2f(-1.0, 3.0),
		);
		return vec4f(positions[vertexIndex], 0.0, 1.0);
	}

	@fragment
	fn fragmentMain(@builtin(position) fragPos: vec4f) -> @location(0) vec4f {
		// Cell coordinate of this pixel; integer values sit on lattice nodes.
		let cell = (fragPos.xy - vec2f(u.phaseX, u.phaseY)) / u.spacingPx;
		// Pixel-space vector to the nearest lattice node.
		let toNode = (cell - round(cell)) * u.spacingPx;
		let d = length(toNode);
		let aa = fwidth(d);
		let cov = (1.0 - smoothstep(u.radiusPx - aa, u.radiusPx + aa, d)) * u.colorA;
		return vec4f(u.colorR * cov, u.colorG * cov, u.colorB * cov, cov);
	}
`;
