/**
 * Fill raster coordinate space: an axis-aligned world region rendered to a
 * raster at a given scale. Mirrors the world→texture mapping used by
 * RenderOrchestrator's export rendering (raster (0,0) = world top-left,
 * Y flipped: world Y-up → raster Y-down).
 */

// --- Types ---

export interface WorldRegion {
	centerX: number;
	centerY: number;
	worldWidth: number;
	worldHeight: number;
}

export interface FillRasterSpace extends WorldRegion {
	/** Raster pixels per world unit. */
	scale: number;
	width: number;
	height: number;
}

// --- Functions ---

export function createRasterSpace(
	region: WorldRegion,
	scale: number,
): FillRasterSpace {
	return {
		...region,
		scale,
		width: Math.max(1, Math.ceil(region.worldWidth * scale)),
		height: Math.max(1, Math.ceil(region.worldHeight * scale)),
	};
}

export function worldToRaster(
	s: FillRasterSpace,
	wx: number,
	wy: number,
): { x: number; y: number } {
	return {
		x: (wx - s.centerX) * s.scale + s.width / 2,
		y: (s.centerY - wy) * s.scale + s.height / 2,
	};
}

export function rasterToWorld(
	s: FillRasterSpace,
	px: number,
	py: number,
): { x: number; y: number } {
	return {
		x: s.centerX + (px - s.width / 2) / s.scale,
		y: s.centerY - (py - s.height / 2) / s.scale,
	};
}

// --- Expanding-window helpers ---

/** Raster-edge contact of a fill mask (raster top = world +Y). */
export interface TouchedEdges {
	left: boolean;
	right: boolean;
	top: boolean;
	bottom: boolean;
}

export function maskTouchedEdges(
	mask: Uint8Array,
	width: number,
	height: number,
): TouchedEdges {
	const touched: TouchedEdges = {
		left: false,
		right: false,
		top: false,
		bottom: false,
	};
	for (let x = 0; x < width; x++) {
		if (mask[x] === 1) touched.top = true;
		if (mask[(height - 1) * width + x] === 1) touched.bottom = true;
	}
	for (let y = 0; y < height; y++) {
		if (mask[y * width] === 1) touched.left = true;
		if (mask[y * width + width - 1] === 1) touched.right = true;
	}
	return touched;
}

/**
 * Grow the region toward each touched raster edge by the current size on that
 * axis, clamped to maxRegion. Returns null when a touched edge is already
 * clamped at maxRegion — the fill escapes past the maximum region, i.e. the
 * filled area is unbounded.
 */
export function expandRegion(
	current: WorldRegion,
	touched: TouchedEdges,
	maxRegion: WorldRegion,
): WorldRegion | null {
	const EPS = 1e-6;
	let minX = current.centerX - current.worldWidth / 2;
	let maxX = current.centerX + current.worldWidth / 2;
	let minY = current.centerY - current.worldHeight / 2;
	let maxY = current.centerY + current.worldHeight / 2;
	const limMinX = maxRegion.centerX - maxRegion.worldWidth / 2;
	const limMaxX = maxRegion.centerX + maxRegion.worldWidth / 2;
	const limMinY = maxRegion.centerY - maxRegion.worldHeight / 2;
	const limMaxY = maxRegion.centerY + maxRegion.worldHeight / 2;

	if (touched.left) {
		if (minX <= limMinX + EPS) return null;
		minX = Math.max(limMinX, minX - current.worldWidth);
	}
	if (touched.right) {
		if (maxX >= limMaxX - EPS) return null;
		maxX = Math.min(limMaxX, maxX + current.worldWidth);
	}
	// Raster top edge is world +Y (Y flip)
	if (touched.top) {
		if (maxY >= limMaxY - EPS) return null;
		maxY = Math.min(limMaxY, maxY + current.worldHeight);
	}
	if (touched.bottom) {
		if (minY <= limMinY + EPS) return null;
		minY = Math.max(limMinY, minY - current.worldHeight);
	}

	return {
		centerX: (minX + maxX) / 2,
		centerY: (minY + maxY) / 2,
		worldWidth: maxX - minX,
		worldHeight: maxY - minY,
	};
}

export function unionRegion(a: WorldRegion, b: WorldRegion): WorldRegion {
	const minX = Math.min(
		a.centerX - a.worldWidth / 2,
		b.centerX - b.worldWidth / 2,
	);
	const maxX = Math.max(
		a.centerX + a.worldWidth / 2,
		b.centerX + b.worldWidth / 2,
	);
	const minY = Math.min(
		a.centerY - a.worldHeight / 2,
		b.centerY - b.worldHeight / 2,
	);
	const maxY = Math.max(
		a.centerY + a.worldHeight / 2,
		b.centerY + b.worldHeight / 2,
	);
	return {
		centerX: (minX + maxX) / 2,
		centerY: (minY + maxY) / 2,
		worldWidth: maxX - minX,
		worldHeight: maxY - minY,
	};
}

export function inflateRegion(r: WorldRegion, margin: number): WorldRegion {
	return {
		centerX: r.centerX,
		centerY: r.centerY,
		worldWidth: r.worldWidth + margin * 2,
		worldHeight: r.worldHeight + margin * 2,
	};
}
