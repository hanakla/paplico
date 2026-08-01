export const STROKE_WIDTH_COMMON_WGSL = /* wgsl */ `
fn strokeWidthCenterRatio(side1Width: f32, side2Width: f32) -> f32 {
	return (side1Width - side2Width) * 0.5;
}

fn strokeWidthHalfRatio(side1Width: f32, side2Width: f32) -> f32 {
	return max((side1Width + side2Width) * 0.5, 0.0);
}

fn strokeWidthPosition(
	side: f32,
	side1Width: f32,
	side2Width: f32,
) -> f32 {
	return strokeWidthCenterRatio(side1Width, side2Width)
		+ side * strokeWidthHalfRatio(side1Width, side2Width);
}

fn strokeWidthAcrossUV(normalizedDistance: f32) -> f32 {
	return (normalizedDistance + 1.0) * 0.5;
}

fn normalizedStampNormalDistance(
	offset: vec2<f32>,
	normal: vec2<f32>,
	halfSize: vec2<f32>,
	rotation: f32,
) -> f32 {
	let normalLength = length(normal);
	if normalLength <= 0.000001 {
		return 0.0;
	}
	let normalizedNormal = normal / normalLength;
	let cosR = cos(rotation);
	let sinR = sin(rotation);
	let axisX = vec2<f32>(cosR, sinR);
	let axisY = vec2<f32>(-sinR, cosR);
	let radius = sqrt(
		pow(halfSize.x * dot(normalizedNormal, axisX), 2.0)
			+ pow(halfSize.y * dot(normalizedNormal, axisY), 2.0),
	);
	if radius <= 0.000001 {
		return 0.0;
	}
	return dot(offset, normalizedNormal) / radius;
}

fn strokeWidthCoverage(
	normalizedDistance: f32,
	side1Width: f32,
	side2Width: f32,
) -> f32 {
	if side1Width >= 1.0 && side2Width >= 1.0 {
		return 1.0;
	}

	let lower = -side2Width;
	let upper = side1Width;
	if upper <= lower {
		return 0.0;
	}

	let feather = min(0.05, (upper - lower) * 0.5);
	var lowerCoverage = 1.0;
	if side2Width < 1.0 {
		lowerCoverage = smoothstep(lower, lower + feather, normalizedDistance);
	}
	var upperCoverage = 1.0;
	if side1Width < 1.0 {
		upperCoverage = 1.0 - smoothstep(upper - feather, upper, normalizedDistance);
	}
	return lowerCoverage * upperCoverage;
}
`;
