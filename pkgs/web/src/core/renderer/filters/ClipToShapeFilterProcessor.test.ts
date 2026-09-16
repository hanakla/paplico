import { afterEach, describe, expect, it, vi } from "vitest";
import type { FilterProcessorContext } from "../canvas/pipeline/FilterRenderer";
import {
	type ClipToShapeFilter,
	ClipToShapeFilterHandler,
} from "./ClipToShapeFilterProcessor";
import {
	SvgCompositeHandler,
	type SvgCompositeParams,
} from "./svg/SvgCompositeHandler";

describe("ClipToShapeFilterHandler", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("should ask the renderer to keep the chain input alive", () => {
		const handler = new ClipToShapeFilterHandler();
		expect(handler.getRenderConfigure().needsSourceGraphic).toBe(true);
	});

	it("should clip the previous result to SourceAlpha", () => {
		const composite = spyOnComposite();
		const context = {} as FilterProcessorContext;

		new ClipToShapeFilterHandler().postProcess(context, clipToShape(false));

		const [passedContext, passedFilter] = composite.mock.calls[0];
		expect(passedContext).toBe(context);
		expect(passedFilter.paramData.params).toMatchObject({
			in: "previous",
			in2: "SourceAlpha",
			operator: "in",
		} satisfies Partial<SvgCompositeParams>);
	});

	it("should keep the outside of the shape when inverted", () => {
		const composite = spyOnComposite();

		new ClipToShapeFilterHandler().postProcess(
			{} as FilterProcessorContext,
			clipToShape(true),
		);

		const passedFilter = composite.mock.calls[0][1];
		expect(passedFilter.paramData.params).toMatchObject({
			operator: "out",
		} satisfies Partial<SvgCompositeParams>);
	});
});

function spyOnComposite() {
	return vi
		.spyOn(SvgCompositeHandler.prototype, "postProcess")
		.mockImplementation(() => {});
}

function clipToShape(invert: boolean): ClipToShapeFilter {
	return {
		uid: "clip",
		processor: "clip-to-shape",
		opacity: 1,
		blendMode: "normal",
		paramData: { version: "1", params: { invert } },
	};
}
