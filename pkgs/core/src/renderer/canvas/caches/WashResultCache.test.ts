import type { WorldBBox } from "../../../utils/geometry/bounds";
import type { ElementFilterPlan } from "../pipeline/RenderPlanner";
import { type WashResult, WashResultCache } from "./WashResultCache";

describe("WashResultCache", () => {
	it("returns the stored result as a borrowed surface on a key match", () => {
		const { cache } = createCache();
		const texture = {} as GPUTexture;
		cache.store("a", result(texture, "k1"));

		const info = cache.get("a", "k1");

		expect(info?.output.texture).toEqual({
			kind: "borrowed",
			texture,
			owner: "external",
		});
	});

	it("misses when the key differs", () => {
		const { cache } = createCache();
		cache.store("a", result({} as GPUTexture, "k1"));

		expect(cache.get("a", "k2")).toBeNull();
	});

	it("releases a replaced result exactly once", () => {
		const { cache, released, discarded } = createCache();
		const first = {} as GPUTexture;
		cache.store("a", result(first, "k1"));

		cache.store("a", result({} as GPUTexture, "k2"));

		expect(released).toEqual([first]);
		expect(discarded).toEqual([]);
	});

	it("releases results of removed elements on prune", () => {
		const { cache, released } = createCache();
		const gone = {} as GPUTexture;
		const kept = {} as GPUTexture;
		cache.store("gone", result(gone, "k"));
		cache.store("kept", result(kept, "k"));

		cache.prune({ kept: {} });

		expect(released).toEqual([gone]);
	});

	it("releases the oldest results once the byte budget is exceeded", () => {
		const { cache, released } = createCache();
		const oldest = {} as GPUTexture;
		const newest = {} as GPUTexture;
		cache.store("a", result(oldest, "k", 300 * 1024 * 1024));

		cache.store("b", result(newest, "k", 300 * 1024 * 1024));

		expect(released).toEqual([oldest]);
		expect(cache.get("b", "k")).not.toBeNull();
	});

	it("discards every result on trimIdle(0) without releasing them", () => {
		const { cache, released, discarded } = createCache();
		const a = {} as GPUTexture;
		const b = {} as GPUTexture;
		cache.store("a", result(a, "k"));
		cache.store("b", result(b, "k"));

		cache.trimIdle(0);

		expect(discarded).toEqual([a, b]);
		expect(released).toEqual([]);
		expect(cache.get("a", "k")).toBeNull();
	});

	it("keeps results used within the idle window on trimIdle", () => {
		const { cache, discarded } = createCache();
		cache.store("a", result({} as GPUTexture, "k"));
		cache.beginDocumentFrame();

		cache.trimIdle(5);

		expect(discarded).toEqual([]);
	});

	it("discards the held results exactly once on destroy", () => {
		const { cache, discarded } = createCache();
		const a = {} as GPUTexture;
		cache.store("a", result(a, "k"));

		cache.destroy();
		cache.destroy();

		expect(discarded).toEqual([a]);
	});

	describe("keyFor", () => {
		it("returns null for a plan without wash appearances", () => {
			const { cache } = createCache();

			expect(cache.keyFor(plan({ wash: false }), 1)).toBeNull();
		});

		it("returns the same key for the same element", () => {
			const { cache } = createCache();
			const fp = plan({ wash: true });

			expect(cache.keyFor(fp, 1)).not.toBeNull();
			expect(cache.keyFor(fp, 1)).toBe(cache.keyFor(fp, 1));
		});
	});
});

const BOUNDS: WorldBBox = {
	minX: 0,
	minY: 0,
	maxX: 10,
	maxY: 10,
	width: 10,
	height: 10,
} as WorldBBox;

function createCache() {
	const released: GPUTexture[] = [];
	const discarded: GPUTexture[] = [];
	const cache = new WashResultCache({
		releaseTexture: (texture) => released.push(texture),
		discardTexture: (texture) => discarded.push(texture),
	});
	return { cache, released, discarded };
}

function result(texture: GPUTexture, key: string, bytes = 1024): WashResult {
	return {
		key,
		texture,
		placement: {
			bounds: BOUNDS,
			uvRect: { minU: 0, minV: 0, maxU: 1, maxV: 1 },
		},
		elementBounds: BOUNDS,
		textureBounds: BOUNDS,
		bytes,
	};
}

function plan({ wash }: { wash: boolean }): ElementFilterPlan {
	return {
		element: {
			id: "p1",
			type: "path",
			segments: [],
			filters: [],
			opacity: 1,
			transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
		},
		textureBounds: BOUNDS,
		allAppearancePlans: [wash ? { washStrokeOpacity: 1 } : {}],
	} as unknown as ElementFilterPlan;
}
