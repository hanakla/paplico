import type { ToolType } from "@/core/tools/toolSettings";
import {
	type CompanionMessage,
	type CompanionState,
	companionRelayRoom,
	decodeCompanionMessage,
	encodeCompanionMessage,
} from "./companionProtocol";

describe("companionProtocol", () => {
	describe("encode / decode", () => {
		it("should return the same message it was given", () => {
			const message: CompanionMessage = {
				type: "command",
				command: { type: "setBrushSize", size: 12.5 },
			};

			expect(decodeCompanionMessage(encodeCompanionMessage(message))).toEqual(
				message,
			);
		});

		it("should carry a whole state through unchanged", () => {
			const message: CompanionMessage = {
				type: "state",
				state: {
					currentTool: "pen",
					strokeColor: {
						type: "solid",
						color: { type: "rgb", r: 1, g: 0, b: 0, a: 1 },
					},
					fillColor: null,
					brushSize: 4,
					opacity: 0.8,
					stabilization: 0.2,
					presets: [{ uid: "preset-1", name: "Pen", builtin: true }],
					selectedPresetUid: "preset-1",
					canUndo: true,
					canRedo: false,
					language: "en",
					selection: {
						count: 1,
						opacity: 1,
						blendMode: "normal",
						compositionMode: "normal",
						filters: [],
					},
					layers: [
						{
							id: "layer-1",
							name: "Layer 1",
							visible: true,
							locked: false,
							opacity: 1,
							blendMode: "normal",
							elements: [],
						},
					],
					currentLayerId: "layer-1",
				},
			};

			expect(decodeCompanionMessage(encodeCompanionMessage(message))).toEqual(
				message,
			);
		});

		it("should return null for bytes that are not JSON", () => {
			expect(decodeCompanionMessage(new Uint8Array([0xff, 0x00, 0xfe]))).toBe(
				null,
			);
		});

		it("should return null for JSON that is not an object", () => {
			expect(decodeCompanionMessage(new TextEncoder().encode('"hello"'))).toBe(
				null,
			);
		});

		it("should return null for an unknown message type", () => {
			expect(
				decodeCompanionMessage(
					new TextEncoder().encode('{"type":"drawEverything"}'),
				),
			).toBe(null);
		});

		it("should return null when there is no type at all", () => {
			expect(decodeCompanionMessage(new TextEncoder().encode("{}"))).toBe(null);
		});
	});

	// A peer on a different version of Paplico is enough to produce any of
	// these. Letting one through means throwing somewhere far from here.
	describe("rejecting bodies that would break the code acting on them", () => {
		const decodeText = (text: string) =>
			decodeCompanionMessage(new TextEncoder().encode(text));

		it("should return null for a command with nothing in it", () => {
			expect(decodeText('{"type":"command"}')).toBe(null);
		});

		it("should return null for an unknown command", () => {
			expect(
				decodeText('{"type":"command","command":{"type":"formatDisk"}}'),
			).toBe(null);
		});

		it("should return null for a command missing its payload", () => {
			expect(
				decodeText('{"type":"command","command":{"type":"setBrushSize"}}'),
			).toBe(null);
			expect(
				decodeText(
					'{"type":"command","command":{"type":"setStrokeColor","color":"red"}}',
				),
			).toBe(null);
		});

		it("should return null for a tool it cannot switch to", () => {
			expect(
				decodeText(
					'{"type":"command","command":{"type":"setTool","tool":"laser"}}',
				),
			).toBe(null);
		});

		it("should return null for a state missing fields the panel reads", () => {
			expect(decodeText('{"type":"state","state":{"currentTool":"pen"}}')).toBe(
				null,
			);
		});

		it("should let a well formed command through", () => {
			expect(
				decodeText(
					'{"type":"command","command":{"type":"setBrushSize","size":4}}',
				),
			).toEqual({
				type: "command",
				command: { type: "setBrushSize", size: 4 },
			});
		});
	});

	describe("elements and filters", () => {
		const decodeText = (text: string) =>
			decodeCompanionMessage(new TextEncoder().encode(text));

		it("should let a selectElement command through", () => {
			expect(
				decodeText(
					'{"type":"command","command":{"type":"selectElement","elementId":"el-1"}}',
				),
			).toEqual({
				type: "command",
				command: { type: "selectElement", elementId: "el-1" },
			});
		});

		it("should return null for a selectElement without an element to select", () => {
			expect(
				decodeText('{"type":"command","command":{"type":"selectElement"}}'),
			).toBe(null);
		});

		it("should let a setElementVisible command through", () => {
			const command: CompanionMessage = {
				type: "command",
				command: {
					type: "setElementVisible",
					layerId: "layer-1",
					elementId: "el-1",
					visible: false,
				},
			};

			expect(decodeCompanionMessage(encodeCompanionMessage(command))).toEqual(
				command,
			);
		});

		it("should return null for a setElementVisible missing its element", () => {
			expect(
				decodeText(
					'{"type":"command","command":{"type":"setElementVisible","layerId":"layer-1","visible":true}}',
				),
			).toBe(null);
		});

		it("should return null for an addFilter that names no processor", () => {
			expect(
				decodeText('{"type":"command","command":{"type":"addFilter"}}'),
			).toBe(null);
		});

		it("should let an addFilter command through", () => {
			expect(
				decodeText(
					'{"type":"command","command":{"type":"addFilter","processor":"@paplico/blur"}}',
				),
			).toEqual({
				type: "command",
				command: { type: "addFilter", processor: "@paplico/blur" },
			});
		});

		// The params belong to the processor, so they are carried as they came.
		it("should carry updateFilter params through whatever they hold", () => {
			const command: CompanionMessage = {
				type: "command",
				command: {
					type: "updateFilter",
					filterUid: "filter-1",
					enabled: true,
					params: { radius: 8, mode: "gaussian", nested: { edge: [1, 2] } },
				},
			};

			expect(decodeCompanionMessage(encodeCompanionMessage(command))).toEqual(
				command,
			);
		});

		it("should return null for updateFilter params that are not an object", () => {
			expect(
				decodeText(
					'{"type":"command","command":{"type":"updateFilter","filterUid":"filter-1","params":"radius=8"}}',
				),
			).toBe(null);
		});

		it("should let a removeFilter command through", () => {
			expect(
				decodeText(
					'{"type":"command","command":{"type":"removeFilter","filterUid":"filter-1"}}',
				),
			).toEqual({
				type: "command",
				command: { type: "removeFilter", filterUid: "filter-1" },
			});
		});

		// A drag drops a row anywhere in the list, so any position in it is a
		// destination the user could have meant.
		it("should let a moveFilter command through for any position in the list", () => {
			for (const toIndex of [0, 3]) {
				const command: CompanionMessage = {
					type: "command",
					command: { type: "moveFilter", filterUid: "filter-1", toIndex },
				};

				expect(
					decodeCompanionMessage(encodeCompanionMessage(command)),
					`toIndex ${toIndex}`,
				).toEqual(command);
			}
		});

		it("should let a moveLayer command through for any position in the list", () => {
			for (const toIndex of [0, 3]) {
				const command: CompanionMessage = {
					type: "command",
					command: { type: "moveLayer", layerId: "layer-1", toIndex },
				};

				expect(
					decodeCompanionMessage(encodeCompanionMessage(command)),
					`toIndex ${toIndex}`,
				).toEqual(command);
			}
		});

		// A destination that is fractional, negative, or not a number at all came
		// from something that does not speak this protocol. Acting on it would put
		// a row somewhere the user never dropped it.
		it("should return null for a destination that is not a place in a list", () => {
			for (const toIndex of ["-1", "1.5", '"2"']) {
				expect(
					decodeText(
						`{"type":"command","command":{"type":"moveFilter","filterUid":"filter-1","toIndex":${toIndex}}}`,
					),
					`toIndex ${toIndex}`,
				).toBe(null);
				expect(
					decodeText(
						`{"type":"command","command":{"type":"moveLayer","layerId":"layer-1","toIndex":${toIndex}}}`,
					),
					`toIndex ${toIndex}`,
				).toBe(null);
			}
		});

		it("should return null for a moveFilter that names no filter", () => {
			expect(
				decodeText(
					'{"type":"command","command":{"type":"moveFilter","toIndex":1}}',
				),
			).toBe(null);
		});

		it("should return null for a moveLayer that names no layer", () => {
			expect(
				decodeText(
					'{"type":"command","command":{"type":"moveLayer","toIndex":1}}',
				),
			).toBe(null);
		});

		it("should accept a state whose layer carries an element", () => {
			const message: CompanionMessage = {
				type: "state",
				state: {
					...SAMPLE_STATE,
					layers: [
						{
							id: "layer-1",
							name: "Layer 1",
							visible: true,
							locked: false,
							opacity: 1,
							blendMode: "normal",
							elements: [
								{
									id: "el-1",
									name: null,
									type: "path",
									visible: true,
									selected: true,
								},
							],
						},
					],
					currentLayerId: "layer-1",
				},
			};

			expect(decodeCompanionMessage(encodeCompanionMessage(message))).toEqual(
				message,
			);
		});

		it("should accept a state whose selection carries a filter", () => {
			const message: CompanionMessage = {
				type: "state",
				state: {
					...SAMPLE_STATE,
					selection: {
						count: 1,
						opacity: 1,
						blendMode: "normal",
						compositionMode: "normal",
						filters: [
							{
								uid: "filter-1",
								processor: "@paplico/unknown-to-this-remote",
								enabled: true,
								opacity: 0.5,
								blendMode: "multiply",
								paramData: { anything: [1, "two", { three: true }] },
							},
						],
					},
				},
			};

			expect(decodeCompanionMessage(encodeCompanionMessage(message))).toEqual(
				message,
			);
		});
	});

	describe("every tool the host can be on", () => {
		// A tool this does not know turns the whole state into something the
		// companion drops, and it freezes with no sign of why.
		it("should accept a state for each tool type", () => {
			for (const tool of TOOL_TYPES_UNDER_TEST) {
				const message = decodeCompanionMessage(
					encodeCompanionMessage({
						type: "state",
						state: { ...SAMPLE_STATE, currentTool: tool },
					}),
				);
				expect(message, tool).not.toBe(null);
			}
		});
	});

	describe("companionRelayRoom", () => {
		it("should not collide with the document room it was derived from", () => {
			expect(companionRelayRoom("room-a")).not.toBe("room-a");
		});

		it("should give different rooms different companion rooms", () => {
			expect(companionRelayRoom("room-a")).not.toBe(
				companionRelayRoom("room-b"),
			);
		});
	});
});

/** Every member of ToolType; adding one without listing it fails to compile. */
const TOOL_TYPES_UNDER_TEST = Object.keys({
	pen: true,
	eraser: true,
	select: true,
	"path-edit": true,
	path: true,
	artboard: true,
	shape: true,
	text: true,
	gradient: true,
	"mesh-deform": true,
	skew: true,
	"free-transform": true,
	"bucket-fill": true,
	"stroke-width-edit": true,
	eyedropper: true,
	reference3d: true,
} satisfies Record<ToolType, true>) as ToolType[];

const SAMPLE_STATE: CompanionState = {
	currentTool: "pen",
	strokeColor: {
		type: "solid",
		color: { type: "rgb", r: 1, g: 0, b: 0, a: 1 },
	},
	fillColor: null,
	brushSize: 4,
	opacity: 1,
	stabilization: 0,
	presets: [],
	selectedPresetUid: null,
	canUndo: false,
	canRedo: false,
	language: "en",
	selection: null,
	layers: [],
	currentLayerId: null,
};
