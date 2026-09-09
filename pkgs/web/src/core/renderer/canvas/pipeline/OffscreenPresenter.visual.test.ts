import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import {
	createArtboard,
	createDefaultDocument,
	createDefaultLayer,
	createDefaultTransform,
} from "../../../document/factory";
import {
	type EmbeddedFile,
	type FillAppearance,
	type Filter,
	type Group,
	generateUid,
	type ImageObject,
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
	it("should bake the group-level pre-filter into the offscreen texture", async () => {
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

describe("Group child atlas masking", () => {
	it("keeps the intersection of inherited silhouette and object appearance masks", async () => {
		const box = await renderAtlasMaskedGroupAndMeasure();

		expect(box.width).toBeGreaterThanOrEqual(55);
		expect(box.width).toBeLessThanOrEqual(65);
		expect(box.height).toBeGreaterThanOrEqual(55);
		expect(box.height).toBeLessThanOrEqual(65);
	});

	it("applies all five nested clip masks", async () => {
		const box = await renderNestedAtlasMaskedGroupAndMeasure();

		expect(box.width).toBeGreaterThanOrEqual(70);
		expect(box.width).toBeLessThanOrEqual(80);
		expect(box.height).toBeGreaterThanOrEqual(55);
		expect(box.height).toBeLessThanOrEqual(65);
	});
});

describe("Top-level atlas masking", () => {
	it("applies the object mask after the path blur", async () => {
		const box = await renderTopLevelAtlasMaskedPathAndMeasure();

		expect(box.width).toBeGreaterThanOrEqual(55);
		expect(box.width).toBeLessThanOrEqual(65);
		expect(box.height).toBeGreaterThanOrEqual(55);
		expect(box.height).toBeLessThanOrEqual(65);
	});

	it("applies the object mask before multiply compositing", async () => {
		const box = await renderTopLevelAtlasMaskedPathAndMeasure("multiply");

		expect(box.width).toBeGreaterThanOrEqual(55);
		expect(box.width).toBeLessThanOrEqual(65);
		expect(box.height).toBeGreaterThanOrEqual(55);
		expect(box.height).toBeLessThanOrEqual(65);
	});
});

describe("Offscreen pixel alignment", () => {
	it("keeps edges crisp through nested clip groups with fractional bounds", async () => {
		// Each offscreen bake snaps to the target's pixel grid; without that a
		// 0.37px clip offset blurs the content edge by ~2px per nesting level.
		const gray = await renderNestedFractionalClipsAndMeasureEdge();
		expect(gray).toBe(0);
	});
});

describe("Clip groups are not isolated", () => {
	it("multiplies a nested clip group's child against the document beneath", async () => {
		const { inside, outside } = await renderNestedClipMultiplyAndSample();
		// Blue × red under multiply is black; a composited (isolated) group would
		// leave the child blue.
		expect(inside[0]).toBeLessThan(20);
		expect(inside[2]).toBeLessThan(20);
		// The nested clip still cuts the child: past its clip the red shows.
		expect(outside[0]).toBeGreaterThan(235);
		expect(outside[2]).toBeLessThan(20);
	});

	it("still clips an image inside a blended group nested in clip groups", async () => {
		// A screen-blended group composites as one layer, so its own bake must
		// carry the inherited clips: the wide image inside must not paint past
		// the inner clip.
		const { inside, outside } = await renderNestedClipMultiplyAndSample(
			1,
			"screen",
			"image",
		);
		expect(inside[0]).toBeGreaterThan(235);
		expect(inside[2]).toBeGreaterThan(235);
		expect(outside[0]).toBeGreaterThan(235);
		expect(outside[2]).toBeLessThan(20);
	});

	it("keeps that behaviour when the clip group is drawn inside an offscreen bake", async () => {
		// The enclosing group's opacity forces an offscreen bake; the multiply
		// child must still see the red rect drawn earlier in that bake. Black at
		// half opacity over white reads mid-grey; blue would keep a high blue.
		const { inside } = await renderNestedClipMultiplyAndSample(0.5);
		expect(inside[0]).toBeGreaterThan(100);
		expect(inside[0]).toBeLessThan(160);
		expect(inside[2]).toBeLessThan(160);
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

async function renderAtlasMaskedGroupAndMeasure() {
	const { renderer, canvas } = await createTestRenderer();
	const doc = createAtlasMaskedGroupDoc();
	const viewport = { x: 0, y: 0, zoom: 1, rotation: 0 };
	const texture = await renderWithViewport(renderer, canvas, doc, viewport);
	const device = renderer.getDevice();
	if (!device) throw new Error("Test renderer has no device");
	const pixels = await captureTexturePixels(device, texture, 800, 600);
	texture.destroy();
	return redBBox(pixels, 800, 600);
}

async function renderNestedAtlasMaskedGroupAndMeasure() {
	const { renderer, canvas } = await createTestRenderer();
	const doc = createNestedAtlasMaskedGroupDoc();
	const viewport = { x: 0, y: 0, zoom: 1, rotation: 0 };
	const texture = await renderWithViewport(renderer, canvas, doc, viewport);
	const device = renderer.getDevice();
	if (!device) throw new Error("Test renderer has no device");
	const pixels = await captureTexturePixels(device, texture, 800, 600);
	texture.destroy();
	return redBBox(pixels, 800, 600);
}

async function renderTopLevelAtlasMaskedPathAndMeasure(
	blendMode: Path["blendMode"] = "normal",
) {
	const { renderer, canvas } = await createTestRenderer();
	const doc = createTopLevelAtlasMaskedPathDoc(blendMode);
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

	const fillApp = solidFill(1, 0, 0);

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

function createAtlasMaskedGroupDoc() {
	const doc = createGroupDoc([]);
	const group = Object.values(doc.objects).find(
		(element): element is Group => element.type === "group",
	);
	const child = Object.values(doc.objects).find(
		(element): element is Path => element.type === "path",
	);
	if (!group || !child) throw new Error("Group fixture is incomplete");

	child.segments = rectSegments(0, 0, 120, 120);
	const clipPath: Path = {
		...child,
		id: generateUid("clip-path"),
		segments: rectSegments(-30, 0, 60, 120),
		filters: [solidFill(1, 1, 1)],
	};
	const objectMask: Path = {
		...child,
		id: generateUid("object-mask"),
		segments: rectSegments(0, 30, 120, 60),
		filters: [solidFill(1, 1, 1)],
	};
	child.mask = { elementIds: [objectMask.id] };
	group.childIds = [child.id, clipPath.id];
	group.clipPathId = clipPath.id;
	doc.objects[clipPath.id] = clipPath;
	doc.objects[objectMask.id] = objectMask;
	return doc;
}

async function renderNestedFractionalClipsAndMeasureEdge() {
	const { renderer, canvas } = await createTestRenderer();
	const doc = createNestedFractionalClipDoc();
	const viewport = { x: 0, y: 0, zoom: 1, rotation: 0 };
	const texture = await renderWithViewport(renderer, canvas, doc, viewport);
	const device = renderer.getDevice();
	if (!device) throw new Error("Test renderer has no device");
	const pixels = await captureTexturePixels(device, texture, 800, 600);
	texture.destroy();
	// Content spans world x -150..150 → screen 250..550. Count intermediate
	// values along the row through the centre where it crosses the left edge.
	let gray = 0;
	for (let x = 240; x < 260; x++) {
		const v = pixels[(300 * 800 + x) * 4];
		if (v > 12 && v < 243) gray++;
	}
	return gray;
}

function createNestedFractionalClipDoc() {
	const doc = createDefaultDocument("fractional-clip-vrt");
	const layer = createDefaultLayer("layer-bg", "Background");
	const child: Path = {
		type: "path",
		id: generateUid("path"),
		opacity: 1,
		blendMode: "normal",
		segments: rectSegments(0, 0, 300, 300),
		filters: [solidFill(0, 0, 0)],
		transform: createDefaultTransform(),
	};
	doc.objects[child.id] = child;
	let contentId = child.id;
	// Clips larger than the content (so its edge stays visible) and larger
	// than the mask atlas limit, offset by a fractional amount per level.
	for (let level = 0; level < 4; level++) {
		const offset = 0.37 * (level + 1);
		const size = 320 + level * 10;
		const clipPath: Path = {
			...child,
			id: generateUid("clip-path"),
			segments: rectSegments(offset, -offset, size, size),
			filters: [solidFill(1, 1, 1)],
		};
		const group: Group = {
			type: "group",
			id: generateUid("group"),
			opacity: 1,
			blendMode: "normal",
			childIds: [contentId, clipPath.id],
			clipPathId: clipPath.id,
			transform: createDefaultTransform(),
			filters: [],
		};
		doc.objects[clipPath.id] = clipPath;
		doc.objects[group.id] = group;
		contentId = group.id;
	}
	layer.elementIds.push(contentId);
	doc.layers = [layer];
	return doc;
}

async function renderNestedClipMultiplyAndSample(
	outerOpacity = 1,
	innerGroupBlend: Group["blendMode"] = "normal",
	content: "path" | "image" = "path",
) {
	const { renderer, canvas } = await createTestRenderer();
	const doc = createNestedClipMultiplyDoc(
		outerOpacity,
		innerGroupBlend,
		content,
	);
	const viewport = { x: 0, y: 0, zoom: 1, rotation: 0 };
	const texture = await renderWithViewport(renderer, canvas, doc, viewport);
	const device = renderer.getDevice();
	if (!device) throw new Error("Test renderer has no device");
	const pixels = await captureTexturePixels(device, texture, 800, 600);
	texture.destroy();
	const at = (x: number, y: number) => {
		const i = (y * 800 + x) * 4;
		return [pixels[i], pixels[i + 1], pixels[i + 2]] as const;
	};
	// Blue child covers world x -100..100 clipped to x -50..50 (screen 350..450).
	return { inside: at(400, 300), outside: at(470, 300) };
}

/**
 * Red rect under a clip group nested in another clip group whose child is a
 * blue multiply rect. Wrapping everything in a group with `outerOpacity` < 1
 * routes the whole thing through an offscreen bake. `innerGroupBlend` wraps
 * the blue rect in a group with that blend mode between the two clips.
 */
function createNestedClipMultiplyDoc(
	outerOpacity: number,
	innerGroupBlend: Group["blendMode"] = "normal",
	content: "path" | "image" = "path",
) {
	const doc = createDefaultDocument("nested-clip-multiply-vrt");
	const layer = createDefaultLayer("layer-bg", "Background");
	const red: Path = {
		type: "path",
		id: generateUid("red"),
		opacity: 1,
		blendMode: "normal",
		segments: rectSegments(0, 0, 400, 300),
		filters: [solidFill(1, 0, 0)],
		transform: createDefaultTransform(),
	};
	const bluePath: Path = {
		...red,
		id: generateUid("blue"),
		blendMode: "multiply",
		segments: rectSegments(0, 0, 200, 100),
		filters: [solidFill(0, 0, 1)],
	};
	const blueImage = solidImage("blue-image", 0, 0, 1, 200, 100);
	doc.files.push(blueImage.file);
	const blue: Path | ImageObject =
		content === "image" ? blueImage.image : bluePath;
	const innerClip: Path = {
		...red,
		id: generateUid("inner-clip"),
		segments: rectSegments(0, 0, 100, 200),
		filters: [solidFill(1, 1, 1)],
	};
	const blended: Group = {
		type: "group",
		id: generateUid("blended"),
		opacity: 1,
		blendMode: innerGroupBlend,
		childIds: [blue.id],
		transform: createDefaultTransform(),
		filters: [],
	};
	const inner: Group = {
		...blended,
		id: generateUid("inner"),
		blendMode: "normal",
		childIds: [
			innerClip.id,
			innerGroupBlend === "normal" ? blue.id : blended.id,
		],
		clipPathId: innerClip.id,
	};
	const outerClip: Path = {
		...innerClip,
		id: generateUid("outer-clip"),
		segments: rectSegments(0, 0, 300, 300),
	};
	const outer: Group = {
		...inner,
		id: generateUid("outer"),
		childIds: [outerClip.id, inner.id],
		clipPathId: outerClip.id,
	};
	const wrapper: Group = {
		...inner,
		id: generateUid("wrapper"),
		opacity: outerOpacity,
		childIds: [red.id, outer.id],
		clipPathId: undefined,
	};
	for (const el of [
		red,
		blue,
		blended,
		innerClip,
		inner,
		outerClip,
		outer,
		wrapper,
	]) {
		doc.objects[el.id] = el;
	}
	layer.elementIds.push(wrapper.id);
	doc.layers = [layer];
	return doc;
}

function createNestedAtlasMaskedGroupDoc() {
	const doc = createDefaultDocument("nested-atlas-mask-vrt");
	const layer = createDefaultLayer("layer-bg", "Background");
	const child: Path = {
		type: "path",
		id: generateUid("path"),
		opacity: 1,
		blendMode: "normal",
		segments: rectSegments(0, 0, 120, 120),
		filters: [solidFill(1, 0, 0)],
		transform: createDefaultTransform(),
	};
	doc.objects[child.id] = child;
	let contentId = child.id;
	const clipRects = [
		[-30, 0, 90, 120],
		[0, 30, 120, 60],
		[0, 0, 120, 120],
		[-10, -10, 140, 140],
		[-20, -20, 160, 160],
	] as const;
	for (const [x, y, width, height] of clipRects) {
		const clipPath: Path = {
			...child,
			id: generateUid("clip-path"),
			segments: rectSegments(x, y, width, height),
			filters: [solidFill(1, 1, 1)],
		};
		const group: Group = {
			type: "group",
			id: generateUid("group"),
			opacity: 1,
			blendMode: "normal",
			childIds: [contentId, clipPath.id],
			clipPathId: clipPath.id,
			transform: createDefaultTransform(),
			filters: [],
		};
		doc.objects[clipPath.id] = clipPath;
		doc.objects[group.id] = group;
		contentId = group.id;
	}
	layer.elementIds.push(contentId);
	doc.layers = [layer];
	doc.artboards.push(createArtboard("ab", "AB", 0, 0, 400, 220));
	return doc;
}

function createTopLevelAtlasMaskedPathDoc(blendMode: Path["blendMode"]) {
	const doc = createDefaultDocument("top-level-atlas-mask-vrt");
	const layer = createDefaultLayer("layer-bg", "Background");
	const child: Path = {
		type: "path",
		id: generateUid("path"),
		opacity: 1,
		blendMode,
		segments: rectSegments(0, 0, 120, 120),
		filters: [solidFill(1, 0, 0), blur(4)],
		transform: createDefaultTransform(),
	};
	const mask: Path = {
		...child,
		id: generateUid("mask"),
		segments: rectSegments(30, 30, 60, 60),
		filters: [solidFill(1, 1, 1)],
	};
	child.mask = { elementIds: [mask.id] };
	doc.objects[mask.id] = mask;
	doc.objects[child.id] = child;
	layer.elementIds.push(child.id);
	doc.layers = [layer];
	doc.artboards.push(createArtboard("ab", "AB", 0, 0, 400, 220));
	return doc;
}

/** A 4×4 solid PNG embedded file plus an ImageObject that stretches it. */
function solidImage(
	id: string,
	r: number,
	g: number,
	b: number,
	width: number,
	height: number,
): { file: EmbeddedFile; image: ImageObject } {
	const png = new PNG({ width: 4, height: 4 });
	for (let i = 0; i < png.data.length; i += 4) {
		png.data[i] = Math.round(r * 255);
		png.data[i + 1] = Math.round(g * 255);
		png.data[i + 2] = Math.round(b * 255);
		png.data[i + 3] = 255;
	}
	const file: EmbeddedFile = {
		uid: `${id}-file`,
		name: `${id}.png`,
		type: "image/png",
		hash: id,
		bin: new Uint8Array(PNG.sync.write(png)),
	};
	const image: ImageObject = {
		type: "image",
		id: generateUid(id),
		fileUid: file.uid,
		x: 0,
		y: 0,
		width,
		height,
		opacity: 1,
		blendMode: "normal",
		transform: createDefaultTransform(),
		filters: [],
	};
	return { file, image };
}

function solidFill(r: number, g: number, b: number): FillAppearance {
	return {
		uid: generateUid("fill"),
		processor: "fill",
		opacity: 1,
		blendMode: "normal",
		paramData: {
			version: "1",
			params: {
				fill: {
					type: "solid",
					color: { type: "rgb", r, g, b, a: 1 },
				},
			},
		},
	};
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
