import { createPassLocalStencilAttachment } from "./PassLocalStencil";

describe("createPassLocalStencilAttachment", () => {
	it("clears pass-local depth and stencil state without storing it", () => {
		const view = {} as GPUTextureView;

		expect(createPassLocalStencilAttachment(view)).toEqual({
			view,
			depthClearValue: 1,
			depthLoadOp: "clear",
			depthStoreOp: "discard",
			stencilClearValue: 0,
			stencilLoadOp: "clear",
			stencilStoreOp: "discard",
		});
	});
});
