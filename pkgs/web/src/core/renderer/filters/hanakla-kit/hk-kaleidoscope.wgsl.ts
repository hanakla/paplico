export const HK_KALEIDOSCOPE_SHADER = /* wgsl */ `
struct Uniforms {
	resolution: vec2f,
	dpiScale: f32,
	patternType: f32,
	segments: f32,
	rotation: f32,
	centerX: f32,
	centerY: f32,
	zoom: f32,
	distortion: f32,
	complexity: f32,
	colorShift: f32,
	cellEffect: f32,
	cellSize: f32,
	blendMode: f32,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var inputSampler: sampler;

struct VertexOutput {
	@builtin(position) position: vec4f,
	@location(0) texCoord: vec2f,
}

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
	var output: VertexOutput;
	let x = f32((vertexIndex & 1u) << 1u);
	let y = f32(vertexIndex & 2u);
	output.position = vec4f(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
	output.texCoord = vec2f(x, y);
	return output;
}

fn degToRad(degrees: f32) -> f32 {
	return degrees * 3.14159265359 / 180.0;
}

fn rotate2D(point: vec2f, center: vec2f, angle: f32) -> vec2f {
	let s = sin(angle);
	let c = cos(angle);
	let p = point - center;
	return vec2f(
		p.x * c - p.y * s,
		p.x * s + p.y * c
	) + center;
}

fn hash(n: f32) -> f32 {
	return fract(sin(n) * 43758.5453);
}

fn hash2D(p: vec2f) -> f32 {
	return hash(p.x + p.y * 57.0);
}

fn random2D(p: vec2f) -> vec2f {
	return vec2f(
		hash(p.x * 127.1 + p.y * 311.7),
		hash(p.x * 269.5 + p.y * 183.3)
	) * 2.0 - 1.0;
}

fn voronoi(uv: vec2f, cSize: f32) -> vec2f {
	let scaledUV = uv / cSize;
	let cellUV = floor(scaledUV);
	let fractUV = vec2f(fract(scaledUV.x), fract(scaledUV.y));

	var minDist = 8.0;
	var cellPoint = vec2f(0.0, 0.0);
	var cellCenter = vec2f(0.0, 0.0);

	for (var y = -1.0; y <= 1.0; y += 1.0) {
		for (var x = -1.0; x <= 1.0; x += 1.0) {
			let cell = cellUV + vec2f(x, y);
			let cellRandom = random2D(cell);
			let pointPos = vec2f(x, y) + 0.5 + 0.5 * cellRandom;
			let diff = pointPos - fractUV;
			let dist = length(diff);

			if (dist < minDist) {
				minDist = dist;
				cellPoint = cell + pointPos;
				cellCenter = cell + vec2f(0.5, 0.5);
			}
		}
	}

	return vec2f(minDist, distance(cellPoint, cellCenter));
}

fn applyCellEffect(coord: vec2f, center: vec2f, cEffect: f32, cSize: f32) -> vec2f {
	if (cEffect <= 0.0) {
		return coord;
	}

	let voronoiResult = voronoi(coord, cSize);
	let cellDistance = voronoiResult.x;
	let centerDistance = voronoiResult.y;

	let distortionStrength = smoothstep(0.0, 0.4, cellDistance) * (1.0 - smoothstep(0.4, 0.5, cellDistance));
	let distortionDirection = normalize(coord - center) * (centerDistance * 0.5 + 0.5);

	return coord + distortionDirection * distortionStrength * cEffect * 0.1;
}

fn applyDistortion(coord: vec2f, center: vec2f, distortionAmount: f32) -> vec2f {
	if (distortionAmount <= 0.0) {
		return coord;
	}

	let offset = coord - center;
	let dist = length(offset);
	let angle = atan2(offset.y, offset.x);

	let wave = sin(dist * 10.0 * distortionAmount) * distortionAmount * 0.1;
	let distortedDistance = dist * (1.0 + wave);

	let twirl = distortionAmount * 5.0 * (1.0 - smoothstep(0.0, 0.5, dist));
	let distortedAngle = angle + twirl;

	return vec2f(
		center.x + cos(distortedAngle) * distortedDistance,
		center.y + sin(distortedAngle) * distortedDistance
	);
}

fn spiralTransform(coord: vec2f, center: vec2f, comp: f32, rot: f32) -> vec2f {
	let offset = coord - center;
	let dist = length(offset);
	let angle = atan2(offset.y, offset.x) + rot;

	let spiralFactor = 0.1 + comp * 0.4;
	let spiralAngle = angle + dist * spiralFactor * 10.0;

	return vec2f(
		center.x + cos(spiralAngle) * dist,
		center.y + sin(spiralAngle) * dist
	);
}

fn fractalTransform(coord: vec2f, center: vec2f, comp: f32, iterations: i32) -> vec2f {
	let z = (coord - center) * 2.0;
	let c = vec2f(
		-0.8 + comp * 0.6,
		0.156
	);

	var result = z;
	for (var i = 0; i < iterations; i++) {
		if (length(result) > 2.0) {
			break;
		}

		result = vec2f(
			result.x * result.x - result.y * result.y,
			2.0 * result.x * result.y
		) + c;
	}

	return center + result * 0.25;
}

fn triangularPattern(uv: vec2f, center: vec2f, segments: i32, rot: f32) -> vec2f {
	let rotatedUV = rotate2D(uv, center, rot);
	let offset = rotatedUV - center;

	let angle = atan2(offset.y, offset.x);
	let dist = length(offset);

	let segmentAngle = 2.0 * 3.14159265359 / f32(segments);
	let segmentIndex = floor(angle / segmentAngle);
	let segmentPosition = angle - segmentAngle * segmentIndex;

	let isEven = segmentIndex % 2.0;
	let finalAngle = select(segmentAngle - segmentPosition, segmentPosition, isEven < 0.5);

	let finalOffset = vec2f(
		cos(finalAngle) * dist,
		sin(finalAngle) * dist
	);

	return finalOffset + center;
}

fn squarePattern(uv: vec2f, center: vec2f, rot: f32) -> vec2f {
	let rotatedUV = rotate2D(uv, center, rot);
	let offset = rotatedUV - center;

	let mirroredOffset = vec2f(abs(offset.x), abs(offset.y));

	return mirroredOffset + center;
}

fn hexagonalPattern(uv: vec2f, center: vec2f, segments: i32, rot: f32) -> vec2f {
	let segmentCount = segments * 2;
	return triangularPattern(uv, center, segmentCount, rot);
}

fn octagonalPattern(uv: vec2f, center: vec2f, rot: f32) -> vec2f {
	let rotatedUV = rotate2D(uv, center, rot);
	let offset = rotatedUV - center;

	let angle = atan2(offset.y, offset.x);
	let dist = length(offset);

	let segmentAngle = 2.0 * 3.14159265359 / 8.0;
	let segmentIndex = floor(angle / segmentAngle);
	let segmentPosition = angle - segmentAngle * segmentIndex;

	let isEven = segmentIndex % 2.0;
	let finalAngle = select(segmentAngle - segmentPosition, segmentPosition, isEven < 0.5);

	let finalOffset = vec2f(
		cos(finalAngle) * dist,
		sin(finalAngle) * dist
	);

	return finalOffset + center;
}

fn circularPattern(uv: vec2f, center: vec2f, segments: i32, rot: f32) -> vec2f {
	let rotatedUV = rotate2D(uv, center, rot);
	let offset = rotatedUV - center;

	let angle = atan2(offset.y, offset.x);
	let dist = length(offset);

	let segmentWidth = 0.1;
	let segmentIndex = floor(dist / segmentWidth);
	let isEven = segmentIndex % 2.0;

	let finalDistance = select(dist,
		segmentWidth * (segmentIndex + 1.0) - (dist - segmentWidth * segmentIndex),
		isEven < 0.5);

	let finalOffset = vec2f(
		cos(angle) * finalDistance,
		sin(angle) * finalDistance
	);

	return finalOffset + center;
}

fn compositePattern(uv: vec2f, center: vec2f, segments: i32, rot: f32, comp: f32) -> vec2f {
	let pattern1 = triangularPattern(uv, center, segments, rot);
	let pattern2 = circularPattern(pattern1, center, segments, rot + 0.3);

	let m = smoothstep(0.3, 0.7, comp);
	return m * pattern2 + (1.0 - m) * pattern1;
}

fn blendCoordinates(coord1: vec2f, coord2: vec2f, bMode: i32, factor: f32) -> vec2f {
	if (bMode == 0) {
		return coord1;
	} else if (bMode == 1) {
		return mix(coord1, coord2, factor);
	} else if (bMode == 2) {
		let dist1 = length(coord1);
		let dist2 = length(coord2);
		return select(coord1, coord2, dist1 > dist2);
	} else {
		let angle = factor * 6.28318;
		let c = cos(angle);
		let s = sin(angle);
		return c * coord1 + s * coord2;
	}
}

fn shiftColor(color: vec4f, shift: f32) -> vec4f {
	if (shift <= 0.0) {
		return color;
	}

	let maxC = max(max(color.r, color.g), color.b);
	let minC = min(min(color.r, color.g), color.b);
	let delta = maxC - minC;

	var h: f32 = 0.0;
	if (delta > 0.0) {
		if (maxC == color.r) {
			h = 6.0 + (color.g - color.b) / delta;
		} else if (maxC == color.g) {
			h = 2.0 + (color.b - color.r) / delta;
		} else {
			h = 4.0 + (color.r - color.g) / delta;
		}
		h = h % 6.0;
	}

	h = (h + shift * 6.0) % 6.0;

	let sector = floor(h);
	let f = h - sector;

	let p = minC;
	let q = minC + (maxC - minC) * (1.0 - f);
	let t = minC + (maxC - minC) * f;

	var newColor: vec3f;

	if (sector == 0.0) {
		newColor = vec3f(maxC, t, p);
	} else if (sector == 1.0) {
		newColor = vec3f(q, maxC, p);
	} else if (sector == 2.0) {
		newColor = vec3f(p, maxC, t);
	} else if (sector == 3.0) {
		newColor = vec3f(p, q, maxC);
	} else if (sector == 4.0) {
		newColor = vec3f(t, p, maxC);
	} else {
		newColor = vec3f(maxC, p, q);
	}

	return vec4f(newColor, color.a);
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
	let texCoord = input.texCoord;

	let kaleidoscopeCenter = vec2f(0.5, 0.5);
	let samplePosition = vec2f(uniforms.centerX, uniforms.centerY);
	let sampleOffset = kaleidoscopeCenter - samplePosition;

	let offsetCoord = (texCoord - kaleidoscopeCenter) / uniforms.zoom + sampleOffset + kaleidoscopeCenter;

	let cellCoord = applyCellEffect(offsetCoord, kaleidoscopeCenter, uniforms.cellEffect, uniforms.cellSize);
	let distortedCoord = applyDistortion(cellCoord, kaleidoscopeCenter, uniforms.distortion);

	let segmentsI = i32(uniforms.segments);
	let patternI = i32(uniforms.patternType);
	let blendModeI = i32(uniforms.blendMode);

	var finalCoord1: vec2f;
	var finalCoord2: vec2f;

	if (patternI == 0) {
		finalCoord1 = triangularPattern(distortedCoord, kaleidoscopeCenter, segmentsI, degToRad(uniforms.rotation));
		finalCoord2 = triangularPattern(distortedCoord, kaleidoscopeCenter, segmentsI * 2, degToRad(uniforms.rotation + 30.0));
	} else if (patternI == 1) {
		finalCoord1 = squarePattern(distortedCoord, kaleidoscopeCenter, degToRad(uniforms.rotation));
		finalCoord2 = squarePattern(distortedCoord, kaleidoscopeCenter, degToRad(uniforms.rotation + 45.0));
	} else if (patternI == 2) {
		finalCoord1 = hexagonalPattern(distortedCoord, kaleidoscopeCenter, segmentsI, degToRad(uniforms.rotation));
		finalCoord2 = hexagonalPattern(distortedCoord, kaleidoscopeCenter, segmentsI + 2, degToRad(uniforms.rotation + 15.0));
	} else if (patternI == 3) {
		finalCoord1 = octagonalPattern(distortedCoord, kaleidoscopeCenter, degToRad(uniforms.rotation));
		finalCoord2 = octagonalPattern(distortedCoord, kaleidoscopeCenter, degToRad(uniforms.rotation + 22.5));
	} else if (patternI == 4) {
		finalCoord1 = circularPattern(distortedCoord, kaleidoscopeCenter, segmentsI, degToRad(uniforms.rotation));
		finalCoord2 = circularPattern(distortedCoord, kaleidoscopeCenter, segmentsI + 1, degToRad(uniforms.rotation));
	} else if (patternI == 5) {
		finalCoord1 = spiralTransform(distortedCoord, kaleidoscopeCenter, uniforms.complexity, degToRad(uniforms.rotation));
		finalCoord2 = spiralTransform(distortedCoord, kaleidoscopeCenter, uniforms.complexity * 0.7, degToRad(uniforms.rotation + 30.0));
	} else if (patternI == 6) {
		let iterations = 2 + i32(uniforms.complexity * 8.0);
		finalCoord1 = fractalTransform(distortedCoord, kaleidoscopeCenter, uniforms.complexity, iterations);
		finalCoord2 = fractalTransform(distortedCoord, kaleidoscopeCenter, uniforms.complexity * 1.1, iterations - 1);
	} else {
		finalCoord1 = compositePattern(distortedCoord, kaleidoscopeCenter, segmentsI, degToRad(uniforms.rotation), uniforms.complexity);
		finalCoord2 = compositePattern(distortedCoord, kaleidoscopeCenter, segmentsI + 1, degToRad(uniforms.rotation + 10.0), uniforms.complexity * 0.8);
	}

	let blendedCoord = blendCoordinates(finalCoord1, finalCoord2, blendModeI, uniforms.complexity);

	let loopedCoord = vec2f(
		blendedCoord.x - floor(blendedCoord.x),
		blendedCoord.y - floor(blendedCoord.y)
	);

	let finalCellCoord = applyCellEffect(loopedCoord, kaleidoscopeCenter, uniforms.cellEffect * 0.5, uniforms.cellSize * 0.5);

	let sampledColor = textureSample(inputTexture, inputSampler, finalCellCoord);

	let finalColor = shiftColor(sampledColor, uniforms.colorShift);

	return finalColor;
}
`;
