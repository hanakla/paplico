import { describe, expect, it } from "vitest";
import { ElementVertexBuffer } from "./ElementVertexBuffer";

describe("ElementVertexBuffer", () => {
	it("should keep an owned snapshot unchanged when the shared scratch buffer is reused", () => {
		const first = new ElementVertexBuffer(0);
		first.pushFill(1, 2, 0.1, 0.2, 0.3, 0.4);
		const sharedView = first.toFloat32Array();
		const owned = first.toOwnedFloat32Array();

		const second = new ElementVertexBuffer(1);
		second.pushFill(99, 88, 0.9, 0.8, 0.7, 0.6);

		expect(sharedView[0]).toBe(99);
		expect(owned).toEqual(
			new Float32Array([1, 2, 0.1, 0.2, 0.3, 0.4, 0, 0, 0]),
		);
	});
});
