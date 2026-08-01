export function createPassLocalStencilAttachment(
	view: GPUTextureView,
): GPURenderPassDepthStencilAttachment {
	return {
		view,
		depthClearValue: 1,
		depthLoadOp: "clear",
		depthStoreOp: "discard",
		stencilClearValue: 0,
		stencilLoadOp: "clear",
		stencilStoreOp: "discard",
	};
}
