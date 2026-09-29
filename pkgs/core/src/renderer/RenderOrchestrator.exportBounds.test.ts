import { createIdentityTransform } from "../document/factory";
import {
	mockDocument,
	mockGroup,
	mockLayer,
	mockPath,
} from "../testUtils/mockElements";
import { closedRectSegments } from "../testUtils/segmentFactory";
import { FontManager } from "../typography/fonts/FontManager";
import { RenderOrchestrator } from "./RenderOrchestrator";

describe("RenderOrchestrator.computeElementsExportBounds", () => {
	it("should place a group child at the group's world position", () => {
		const child = mockPath("child-1");
		child.segments = closedRectSegments(0, 0, 40, 40);
		const group = mockGroup("group-1", [child.id], { x: 500 });
		const document = mockDocument(
			[child, group],
			[mockLayer("layer-1", [group.id])],
		);

		const bounds = new RenderOrchestrator(
			new FontManager({ loaders: [] }),
		).computeElementsExportBounds([child.id], document);

		expect(bounds).not.toBeNull();
		expect(bounds!.centerX).toBeCloseTo(520);
		expect(bounds!.width).toBeCloseTo(40);
	});

	it("should turn a rotated group's child around the group's local origin", () => {
		const child = mockPath("child-1");
		child.segments = closedRectSegments(0, 0, 40, 40);
		child.transform = { ...createIdentityTransform(), x: 100 };
		const group = mockGroup("group-1", [child.id], { rotation: Math.PI / 2 });
		const document = mockDocument(
			[child, group],
			[mockLayer("layer-1", [group.id])],
		);

		const bounds = new RenderOrchestrator(
			new FontManager({ loaders: [] }),
		).computeElementsExportBounds([child.id], document);

		expect(bounds).not.toBeNull();
		// The square sits at x 100..140, y 0..40 in the group's space. A quarter
		// turn around the group's origin lands it at x -40..0, y 100..140.
		expect(bounds!.centerX).toBeCloseTo(-20);
		expect(bounds!.centerY).toBeCloseTo(120);
	});
});
