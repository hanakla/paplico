import { describe, expect, it, vi } from "vitest";
import type { PaplicoCommands } from "@/core/PaplicoCommands";
import type { Document } from "@/core/schema";
import { PaplicoAutomationDom } from "./dom";

describe("PaplicoAutomationDom", () => {
	it("should preserve wrapper identity and expose buffered writes immediately", () => {
		const { dom } = makeDom();
		dom.begin();

		const first = dom.getActiveDocument().findArtObject("rect-1");
		const second = dom.getActiveDocument().findArtObject("rect-1");
		expect(first).toBe(second);

		if (!first) throw new Error("Expected the fixture object");
		first.name = "Renamed";
		first.transform.x = 42;

		expect(second?.name).toBe("Renamed");
		expect(second?.transform.x).toBe(42);
	});

	it("should replay buffered writes in one command transaction", () => {
		const { dom, commands } = makeDom();
		dom.begin();
		const object = dom.getActiveDocument().findArtObject("rect-1");
		if (!object) throw new Error("Expected the fixture object");
		object.opacity = 0.5;
		object.transform.y = 24;

		dom.commit();

		expect(commands.transact).toHaveBeenCalledTimes(1);
		expect(commands.stopUndoCapture).toHaveBeenCalledTimes(2);
		expect(commands.updateElement).toHaveBeenCalledWith("layer-1", "rect-1", {
			opacity: 0.5,
			transform: {
				x: 10,
				y: 24,
				rotation: 0,
				scaleX: 1,
				scaleY: 1,
			},
		});
	});

	it("should discard buffered writes when execution rolls back", () => {
		const { dom, commands } = makeDom();
		dom.begin();
		const object = dom.getActiveDocument().findArtObject("rect-1");
		if (!object) throw new Error("Expected the fixture object");
		object.visible = false;

		dom.rollback();

		expect(commands.transact).not.toHaveBeenCalled();
		expect(commands.updateElement).not.toHaveBeenCalled();
	});

	it("should preserve concurrent changes to untouched nested fields", () => {
		const { dom, commands, document } = makeDom();
		dom.begin();
		const object = dom.getActiveDocument().findArtObject("rect-1");
		if (!object) throw new Error("Expected the fixture object");
		object.transform.x = 42;
		document.objects["rect-1"].transform.y = 99;

		dom.commit();

		expect(commands.updateElement).toHaveBeenCalledWith("layer-1", "rect-1", {
			transform: {
				x: 42,
				y: 99,
				rotation: 0,
				scaleX: 1,
				scaleY: 1,
			},
		});
	});

	it("should update objects that are not attached to a layer", () => {
		const { dom, commands, document } = makeDom();
		document.objects["detached"] = {
			...document.objects["rect-1"],
			id: "detached",
		};
		dom.begin();
		const object = dom.getActiveDocument().findArtObject("detached");
		if (!object) throw new Error("Expected the detached object");
		object.name = "Updated";

		dom.commit();

		expect(commands.updateElement).toHaveBeenCalledWith("", "detached", {
			name: "Updated",
		});
	});

	it("should ignore commands for objects deleted before commit", () => {
		const { dom, commands, document } = makeDom();
		dom.begin();
		const object = dom.getActiveDocument().findArtObject("rect-1");
		if (!object) throw new Error("Expected the fixture object");
		object.name = "Renamed";
		delete document.objects["rect-1"];

		dom.commit();

		expect(commands.transact).toHaveBeenCalledTimes(1);
		expect(commands.updateElement).not.toHaveBeenCalled();
	});

	it("should commit document settings once while preserving concurrent nested changes", () => {
		const { dom, commands, document } = makeDom();
		dom.begin();
		const activeDocument = dom.getActiveDocument() as unknown as {
			hdr: { enabled: boolean; exposure: number };
			colorProfile: {
				workingSpace: "srgb" | "display-p3";
				proofIntent?: "perceptual" | "relative-colorimetric";
			};
			rasterizationDpi: number;
		};
		activeDocument.hdr.exposure = 1.5;
		activeDocument.colorProfile.workingSpace = "display-p3";
		activeDocument.rasterizationDpi = 144;
		if (!document.hdr || !document.colorProfile) {
			throw new Error("Expected document settings");
		}
		document.hdr.enabled = true;
		document.colorProfile.proofIntent = "perceptual";

		dom.commit();

		expect(commands.transact).toHaveBeenCalledTimes(1);
		expect(commands.setHdr).toHaveBeenCalledWith({
			enabled: true,
			exposure: 1.5,
		});
		expect(commands.setColorProfile).toHaveBeenCalledWith({
			workingSpace: "display-p3",
			proofIntent: "perceptual",
		});
		expect(commands.setRasterizationDpi).toHaveBeenCalledWith(144);
	});

	it("should ignore layers and artboards deleted before commit", () => {
		const { dom, commands, document } = makeDom();
		dom.begin();
		const activeDocument = dom.getActiveDocument();
		const layer = activeDocument.findLayer("layer-1");
		const artboard = activeDocument.findArtboard("artboard-1");
		if (!layer || !artboard) throw new Error("Expected the fixture entities");
		layer.name = "Renamed Layer";
		artboard.name = "Renamed Artboard";
		document.layers = [];
		document.artboards = [];

		expect(() => dom.commit()).not.toThrow();
		expect(commands.transact).toHaveBeenCalledTimes(1);
		expect(commands.updateLayer).not.toHaveBeenCalled();
		expect(commands.updateArtboard).not.toHaveBeenCalled();
	});
});

function makeDom() {
	const document = {
		id: "doc-1",
		objects: {
			"rect-1": {
				id: "rect-1",
				type: "path",
				name: "Rect",
				visible: true,
				locked: false,
				opacity: 1,
				blendMode: "normal",
				compositionMode: "normal",
				filters: [],
				transform: {
					x: 10,
					y: 20,
					rotation: 0,
					scaleX: 1,
					scaleY: 1,
				},
				segments: [],
				closed: true,
			},
		},
		layers: [
			{
				id: "layer-1",
				name: "Layer",
				visible: true,
				locked: false,
				opacity: 1,
				blendMode: "normal",
				elementIds: ["rect-1"],
			},
		],
		artboards: [
			{
				id: "artboard-1",
				name: "Artboard",
				x: 0,
				y: 0,
				width: 800,
				height: 600,
			},
		],
		hdr: {
			enabled: false,
			exposure: 0,
		},
		colorProfile: {
			workingSpace: "srgb",
			proofIntent: "relative-colorimetric",
		},
		rasterizationDpi: 72,
	} as unknown as Document;
	const commandMethods = {
		updateElement: vi.fn(),
		updateLayer: vi.fn(),
		updateArtboard: vi.fn(),
		setHdr: vi.fn(),
		setColorProfile: vi.fn(),
		setRasterizationDpi: vi.fn(),
	};
	const commands = {
		...commandMethods,
		stopUndoCapture: vi.fn(),
		transact: vi.fn((fn: (commands: PaplicoCommands) => void) =>
			fn(commandMethods as unknown as PaplicoCommands),
		),
	};
	const selection = {
		clear: vi.fn(),
		selectMultiple: vi.fn(),
	};
	const dom = new PaplicoAutomationDom({
		uiState: {
			document,
			selectedElementIds: [],
			currentLayerId: "layer-1",
		},
		commands,
		selection,
	});
	return { dom, commands, document, selection };
}
