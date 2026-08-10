/** A closed ring approximated as a point list, for containment tests. */
export type ContainmentRing = readonly (readonly [number, number])[];

/**
 * Group rings by containment. Each returned group holds indices into `rings`:
 * the first is an outer ring, the rest are the holes it encloses. Nesting
 * alternates, so a ring inside a hole starts a new group — the reading fonts
 * and compound paths use for counters within counters.
 *
 * The reason this exists once: a boolean union treats every operand as solid,
 * so handing it a glyph's outer and its counter as two operands unions the
 * counter shut. Callers must first fold each shape's holes into that shape.
 */
export function groupRingsByContainment(
	rings: readonly ContainmentRing[],
): number[][] {
	const areas = rings.map(ringArea);
	const boxes = rings.map(ringBBox);
	// Test each ring by a point strictly inside it, never by one of its vertices.
	// Glyph geometry lines its parts up on a shared grid, so a vertex regularly
	// lands exactly on another ring's edge, where the crossing test is undefined.
	const probes = rings.map((ring, i) => interiorPoint(ring, boxes[i]));

	// Innermost enclosing ring, or -1 at top level. Smallest enclosing area wins
	// so a counter attaches to its own glyph rather than to a larger neighbour.
	// The bounding-box test runs first because it is both cheap and decisive.
	const parents = rings.map((_, i) => {
		const probe = probes[i];
		if (!probe) return -1;
		let parent = -1;
		for (let j = 0; j < rings.length; j++) {
			if (i === j || areas[j] <= areas[i]) continue;
			if (!bboxContains(boxes[j], boxes[i])) continue;
			if (!pointInRing(probe, rings[j])) continue;
			if (parent === -1 || areas[j] < areas[parent]) parent = j;
		}
		return parent;
	});

	const depths = rings.map((_, i) => {
		let depth = 0;
		let cursor = parents[i];
		const seen = new Set<number>();
		while (cursor !== -1 && !seen.has(cursor)) {
			seen.add(cursor);
			depth++;
			cursor = parents[cursor];
		}
		return depth;
	});

	const groups = new Map<number, number[]>();
	rings.forEach((_, i) => {
		if (depths[i] % 2 === 0) groups.set(i, [i]);
	});
	rings.forEach((_, i) => {
		if (depths[i] % 2 === 0) return;
		const owner = groups.get(parents[i]);
		// A hole whose owner is itself odd-depth (degenerate nesting) has no group
		// to join; keep it as its own outer rather than dropping it.
		if (owner) owner.push(i);
		else groups.set(i, [i]);
	});
	return [...groups.values()];
}

// Helpers

interface RingBBox {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

function ringBBox(ring: ContainmentRing): RingBBox {
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const [x, y] of ring) {
		if (x < minX) minX = x;
		if (y < minY) minY = y;
		if (x > maxX) maxX = x;
		if (y > maxY) maxY = y;
	}
	return { minX, minY, maxX, maxY };
}

function bboxContains(outer: RingBBox, inner: RingBBox): boolean {
	return (
		outer.minX <= inner.minX &&
		outer.minY <= inner.minY &&
		outer.maxX >= inner.maxX &&
		outer.maxY >= inner.maxY
	);
}

/**
 * A point strictly inside the ring: the midpoint of the first span its
 * horizontal centre line cuts through. Null when the ring is degenerate (no
 * span at that height), which callers read as "encloses nothing".
 */
function interiorPoint(
	ring: ContainmentRing,
	box: RingBBox,
): readonly [number, number] | null {
	if (ring.length < 3) return null;
	const y = (box.minY + box.maxY) / 2;
	const crossings: number[] = [];
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const [xi, yi] = ring[i];
		const [xj, yj] = ring[j];
		if (yi > y === yj > y) continue;
		crossings.push(xi + ((y - yi) / (yj - yi)) * (xj - xi));
	}
	if (crossings.length < 2) return null;
	crossings.sort((a, b) => a - b);
	if (!(crossings[1] > crossings[0])) return null;
	return [(crossings[0] + crossings[1]) / 2, y];
}

function ringArea(ring: ContainmentRing): number {
	let sum = 0;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		sum += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
	}
	return Math.abs(sum / 2);
}

function pointInRing(
	point: readonly [number, number],
	ring: ContainmentRing,
): boolean {
	let inside = false;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const [xi, yi] = ring[i];
		const [xj, yj] = ring[j];
		if (
			yi > point[1] !== yj > point[1] &&
			point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi
		) {
			inside = !inside;
		}
	}
	return inside;
}
