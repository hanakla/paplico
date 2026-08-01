import { describe, expect, it } from "vitest";
import {
	createArtboard,
	createDefaultDocument,
	createDefaultLayer,
	createDefaultTransform,
} from "../../../document/factory";
import {
	type FillAppearance,
	type Filter,
	type Group,
	generateUid,
	type Path,
	type PathSegment,
} from "../../../schema";
import {
	captureTexturePixels,
	createTestRenderer,
	renderWithViewport,
} from "../../../testUtils/visualRegression";

// A group-level pre-filter (3d-rotate) must survive the offscreen route that
// a raster post filter forces the group through: the deformation propagates
// into pre-rasterized children and the plan bounds cover the deformed extent.
// Regression for "group 3d-rotate is dropped and clipped at the flat bbox
// once a raster filter is added".

describe("Group 3d-rotate with raster post filter", () => {
	it("should keep the rotated silhouette when a blur post filter is added", async () => {
		const box = await renderGroupAndMeasure([rotate3d(0, 0, 45), blur(2)]);
		// Flat 200×100 rect rotated 45° covers ~212×212; without the fix the
		// group renders flat (200×100).
		expect(box.height).toBeGreaterThan(180);
		expect(box.width).toBeGreaterThan(200);
	});

	it("should keep the perspective silhouette when a blur post filter is added", async () => {
		const box = await renderGroupAndMeasure([rotate3d(55, 0, 0), blur(2)]);
		// rotateX squashes the rect to a ~252×60 trapezoid; without the fix the
		// group renders flat (200×100).
		expect(box.width).toBeGreaterThan(230);
		expect(box.height).toBeLessThan(90);
	});

	it("should keep spray scatter around the deformed silhouette", async () => {
		const box = await renderGroupAndMeasure([rotate3d(55, 0, 0), spraying(30)]);
		// The ~252×60 trapezoid must gain visible scatter on every side
		// (measured 293×125 unclipped) instead of being cut at the plan bounds.
		expect(box.width).toBeGreaterThan(270);
		expect(box.height).toBeGreaterThan(110);
	});

	it("should cover the deformed extent when the group itself is transformed", async () => {
		const box = await renderGroupAndMeasure([rotate3d(55, 0, 0), blur(2)], {
			...createDefaultTransform(),
			x: 60,
			y: -30,
			scaleX: 1.5,
			scaleY: 1.5,
		});
		// The trapezoid scales to ~378×90 at the moved position. Without
		// composing the group transform into the deformed plan bounds the
		// texture ends at ~348 drawable width, clipping the right flare.
		expect(box.width).toBeGreaterThan(350);
		expect(box.height).toBeLessThan(120);
	});
});

function spraying(strength: number): Filter {
	return {
		uid: generateUid("filter"),
		processor: "hk:spraying",
		opacity: 1,
		blendMode: "normal",
		enabled: true,
		paramData: {
			version: "1",
			params: { strength, seed: 42, blockSize: 4 },
		},
	};
}

async function renderGroupAndMeasure(
	groupFilters: Filter[],
	groupTransform?: Group["transform"],
) {
	const { renderer, canvas } = await createTestRenderer();
	const doc = createGroupDoc(groupFilters, groupTransform);
	const viewport = { x: 0, y: 0, zoom: 1, rotation: 0 };
	const texture = await renderWithViewport(renderer, canvas, doc, viewport);
	const device = renderer.getDevice();
	if (!device) throw new Error("Test renderer has no device");
	const pixels = await captureTexturePixels(device, texture, 800, 600);
	texture.destroy();
	return redBBox(pixels, 800, 600);
}

function createGroupDoc(
	groupFilters: Filter[],
	groupTransform?: Group["transform"],
) {
	const doc = createDefaultDocument("group-prefilter-vrt");
	const layer = createDefaultLayer("layer-bg", "Background");

	const fillApp: FillAppearance = {
		uid: generateUid("fill"),
		processor: "fill",
		opacity: 1,
		blendMode: "normal",
		paramData: {
			version: "1",
			params: {
				fill: {
					type: "solid",
					color: { type: "rgb", r: 1, g: 0, b: 0, a: 1 },
				},
			},
		},
	};

	const rect: Path = {
		type: "path",
		id: generateUid("path"),
		opacity: 1,
		blendMode: "normal",
		segments: rectSegments(0, 0, 200, 100),
		filters: [fillApp],
		transform: createDefaultTransform(),
	};

	const group: Group = {
		type: "group",
		id: generateUid("group"),
		opacity: 1,
		blendMode: "normal",
		childIds: [rect.id],
		transform: groupTransform ?? createDefaultTransform(),
		filters: groupFilters,
	};

	doc.objects[rect.id] = rect;
	doc.objects[group.id] = group;
	layer.elementIds.push(group.id);
	doc.layers = [layer];
	doc.artboards.push(createArtboard("ab", "AB", 0, 0, 400, 220));
	return doc;
}

function rotate3d(rotateX: number, rotateY: number, rotateZ: number): Filter {
	return {
		uid: generateUid("filter"),
		processor: "3d-rotate",
		opacity: 1,
		blendMode: "normal",
		enabled: true,
		paramData: {
			version: "1",
			params: { rotateX, rotateY, rotateZ, perspective: 60 },
		},
	};
}

function blur(radius: number): Filter {
	return {
		uid: generateUid("filter"),
		processor: "blur",
		opacity: 1,
		blendMode: "normal",
		enabled: true,
		paramData: { version: "1", params: { radius } },
	};
}

/** Bounding box of clearly red pixels (the rect fill) over the white/gray
 *  test background. */
function redBBox(pixels: Uint8Array, w: number, h: number) {
	let minX = w;
	let minY = h;
	let maxX = -1;
	let maxY = -1;
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const i = (y * w + x) * 4;
			if (pixels[i] > 180 && pixels[i + 1] < 120 && pixels[i + 2] < 120) {
				if (x < minX) minX = x;
				if (x > maxX) maxX = x;
				if (y < minY) minY = y;
				if (y > maxY) maxY = y;
			}
		}
	}
	if (maxX < 0) return { width: 0, height: 0 };
	return { width: maxX - minX + 1, height: maxY - minY + 1 };
}

function lineSegment(
	sx: number,
	sy: number,
	ex: number,
	ey: number,
	moved: boolean,
	closed?: boolean,
): PathSegment {
	return {
		start: moved ? { x: sx, y: sy } : undefined,
		cp1: { x: 0, y: 0 },
		cp2: { x: 0, y: 0 },
		end: { x: ex, y: ey },
		startPressure: 1,
		endPressure: 1,
		startTiltX: 0,
		startTiltY: 0,
		endTiltX: 0,
		endTiltY: 0,
		startDeltaTime: 0,
		endDeltaTime: 0,
		isMoved: moved,
		isClosed: closed,
	};
}

function rectSegments(
	x: number,
	y: number,
	w: number,
	h: number,
): PathSegment[] {
	return [
		lineSegment(x - w / 2, y + h / 2, x + w / 2, y + h / 2, true),
		lineSegment(x + w / 2, y + h / 2, x + w / 2, y - h / 2, false),
		lineSegment(x + w / 2, y - h / 2, x - w / 2, y - h / 2, false),
		lineSegment(x - w / 2, y - h / 2, x - w / 2, y + h / 2, false, true),
	];
}
