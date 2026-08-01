import { act, renderHook } from "@testing-library/react";
import { proxy } from "valtio";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	AnyArtObject,
	FillAppearance,
	FillColor,
	StrokeAppearance,
} from "@/core/schema";
import { useActiveColors } from "./useActiveColors";

// --- Mock setup ---

const mockTools = {
	state: proxy({
		strokeAppearance: {
			uid: "test-stroke",
			processor: "stroke" as const,
			opacity: 1,
			blendMode: "normal" as const,
			paramData: {
				version: "1",
				params: {
					strokeColor: {
						type: "solid" as const,
						color: { type: "rgb" as const, r: 1, g: 0, b: 0, a: 1 },
					},
				},
			},
		},
		fillAppearance: {
			uid: "test-fill",
			processor: "fill" as const,
			opacity: 1,
			blendMode: "normal" as const,
			paramData: {
				version: "1",
				params: {
					fill: {
						type: "solid" as const,
						color: { type: "rgb" as const, r: 0, g: 0, b: 1, a: 1 },
					},
				},
			},
		} as FillAppearance | null,
		currentTool: "select" as string,
	}),
	setFillColor: vi.fn(),
	setStrokeColor: vi.fn(),
};

const mockCommands = {
	updateSelectedElementsFill: vi.fn(),
	updateSelectedElementsStrokeColor: vi.fn(),
};

let mockStore = createMockStore();

vi.mock("@/contexts/PaplicoContext", () => ({
	usePaplico: () => ({
		tools: mockTools,
		uiState: mockStore,
		commands: mockCommands,
		getActiveStrokeAppearance: () => {
			if (mockStore.selectedElementIds.length > 0) {
				const el = mockStore.document.objects[mockStore.selectedElementIds[0]];
				const stroke = el?.filters?.find(
					(f: { processor: string }) => f.processor === "stroke",
				);
				return stroke ?? null;
			}
			return mockTools.state.strokeAppearance;
		},
		getActiveFillAppearance: () => {
			if (mockStore.selectedElementIds.length > 0) {
				const el = mockStore.document.objects[mockStore.selectedElementIds[0]];
				const fill = el?.filters?.find(
					(f: { processor: string }) => f.processor === "fill",
				);
				if (fill) return fill;
				return null;
			}
			return mockTools.state.fillAppearance;
		},
	}),
}));

// --- Tests ---

const RED = { type: "rgb" as const, r: 1, g: 0, b: 0, a: 1 };
const BLUE = { type: "rgb" as const, r: 0, g: 0, b: 1, a: 1 };

describe("useActiveColors", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockStore = createMockStore();
		mockTools.state.strokeAppearance = {
			uid: "test-stroke",
			processor: "stroke",
			opacity: 1,
			blendMode: "normal",
			paramData: {
				version: "1",
				params: {
					strokeColor: {
						type: "solid",
						color: { type: "rgb", r: 1, g: 0, b: 0, a: 1 },
					},
				},
			},
		};
		mockTools.state.fillAppearance = {
			uid: "test-fill",
			processor: "fill",
			opacity: 1,
			blendMode: "normal",
			paramData: {
				version: "1",
				params: {
					fill: {
						type: "solid",
						color: { type: "rgb", r: 0, g: 0, b: 1, a: 1 },
					},
				},
			},
		};
	});

	describe("when nothing is selected", () => {
		it("should return tool colors as solid fill", () => {
			const { result } = renderHook(() => useActiveColors());

			expect(result.current.selectedElements).toHaveLength(0);
			expect(result.current.hasMixedFillColor).toBe(false);
			expect(result.current.hasMixedStrokeColor).toBe(false);
			expect(result.current.currentFill).toEqual({
				type: "solid",
				color: { type: "rgb", r: 0, g: 0, b: 1, a: 1 },
			});
			expect(result.current.currentStrokeFill).toEqual({
				type: "solid",
				color: { type: "rgb", r: 1, g: 0, b: 0, a: 1 },
			});
			expect(result.current.currentStrokeGradientMode).toBe("within");
		});

		it("should return null fill when tool fillAppearance is null", () => {
			mockTools.state.fillAppearance = null;
			const { result } = renderHook(() => useActiveColors());
			expect(result.current.currentFill).toBeNull();
		});

		describe("when handleGradientFillChange is called with a solid color", () => {
			it("should set color on tool and uiStore", () => {
				const { result } = renderHook(() => useActiveColors());

				act(() => {
					result.current.handleGradientFillChange({
						type: "solid",
						color: RED,
					});
				});

				expect(mockTools.setFillColor).toHaveBeenCalledWith({
					type: "solid",
					color: RED,
				});
			});
		});

		describe("when handleGradientFillChange is called with null", () => {
			it("should clear fill color", () => {
				const { result } = renderHook(() => useActiveColors());

				act(() => {
					result.current.handleGradientFillChange(null);
				});

				expect(mockTools.setFillColor).toHaveBeenCalledWith(null);
			});
		});
	});

	describe("when a single element is selected", () => {
		it("should return element's fill and stroke colors", () => {
			mockStore = createMockStore({
				selectedElementIds: ["e1"],
				objects: {
					e1: makeElement("e1", {
						strokeColor: { type: "solid", color: RED },
						fill: { type: "solid", color: BLUE },
					}),
				},
			});

			const { result } = renderHook(() => useActiveColors());

			expect(result.current.selectedElements).toHaveLength(1);
			expect(result.current.currentFill).toEqual({
				type: "solid",
				color: BLUE,
			});
			expect(result.current.currentStrokeFill).toEqual({
				type: "solid",
				color: RED,
			});
			expect(result.current.hasMixedFillColor).toBe(false);
			expect(result.current.hasMixedStrokeColor).toBe(false);
		});

		describe("when handleGradientFillChange is called", () => {
			it("should apply fill to selected elements", () => {
				mockStore = createMockStore({
					selectedElementIds: ["e1"],
					objects: {
						e1: makeElement("e1", {
							fill: { type: "solid", color: RED },
						}),
					},
				});

				const { result } = renderHook(() => useActiveColors());
				const newFill: FillColor = { type: "solid", color: BLUE };

				act(() => {
					result.current.handleGradientFillChange(newFill);
				});

				expect(mockCommands.updateSelectedElementsFill).toHaveBeenCalledWith(
					newFill,
				);
			});

			it("should keep non-mesh elements and apply a mesh fill without conversion", () => {
				mockStore = createMockStore({
					selectedElementIds: ["e1"],
					objects: {
						e1: makeElement("e1", {
							fill: { type: "solid", color: RED },
						}),
					},
				});

				const { result } = renderHook(() => useActiveColors());
				const newFill: FillColor = {
					type: "mesh",
					vertices: [
						{
							x: 0,
							y: 0,
							color: RED,
							colorMode: "explicit",
							handles: { 1: { x: 0.25, y: 0 } },
						},
						{
							x: 1,
							y: 0,
							color: BLUE,
							colorMode: "explicit",
							handles: { 0: { x: 0.75, y: 0 } },
						},
						{
							x: 1,
							y: 1,
							color: BLUE,
							colorMode: "explicit",
							handles: { 3: { x: 1, y: 0.75 } },
						},
						{
							x: 0,
							y: 1,
							color: RED,
							colorMode: "explicit",
							handles: { 2: { x: 0, y: 0.75 } },
						},
					],
					faces: [{ type: "quad", verts: [0, 1, 2, 3] }],
				};

				act(() => {
					result.current.handleGradientFillChange(newFill);
				});

				expect(mockCommands.updateSelectedElementsFill).toHaveBeenCalledWith(
					newFill,
				);
			});
		});

		describe("when handleStrokeGradientChange is called with a solid color", () => {
			it("should set tool color and update element stroke", () => {
				mockStore = createMockStore({
					selectedElementIds: ["e1"],
					objects: {
						e1: makeElement("e1", {
							strokeColor: { type: "solid", color: RED },
						}),
					},
				});

				const { result } = renderHook(() => useActiveColors());

				act(() => {
					result.current.handleStrokeGradientChange({
						type: "solid",
						color: BLUE,
					});
				});

				expect(mockTools.setStrokeColor).toHaveBeenCalledWith({
					type: "solid",
					color: BLUE,
				});
				expect(
					mockCommands.updateSelectedElementsStrokeColor,
				).toHaveBeenCalledWith({ type: "solid", color: BLUE });
			});
		});

		describe("when handleStrokeGradientChange is called with a linear gradient", () => {
			it("should convert to stroke-gradient with current mode", () => {
				mockStore = createMockStore({
					selectedElementIds: ["e1"],
					objects: {
						e1: makeElement("e1", {
							strokeColor: { type: "solid", color: RED },
						}),
					},
				});

				const { result } = renderHook(() => useActiveColors());
				const linearFill: FillColor = {
					type: "linear",
					x1: 0,
					y1: 0,
					x2: 1,
					y2: 0,
					stops: [
						{ offset: 0, color: RED, midpoint: 0.5 },
						{ offset: 1, color: BLUE, midpoint: 0.5 },
					],
				};

				act(() => {
					result.current.handleStrokeGradientChange(linearFill);
				});

				expect(
					mockCommands.updateSelectedElementsStrokeColor,
				).toHaveBeenCalledWith({
					type: "stroke-gradient",
					gradient: linearFill,
					mode: "within",
				});
			});
		});
	});

	describe("when a Blend object is selected", () => {
		it("reports no fill or stroke color (a blend has none)", () => {
			mockStore = createMockStore({
				selectedElementIds: ["b1"],
				objects: {
					b1: {
						id: "b1",
						type: "blend",
						objectIds: ["x", "y"],
						spacing: { type: "steps", count: 5 },
						opacity: 1,
						blendMode: "normal",
					} as unknown as AnyArtObject,
				},
			});

			const { result } = renderHook(() => useActiveColors());

			expect(result.current.currentFill).toBeNull();
			expect(result.current.currentStrokeFill).toBeNull();
			expect(result.current.hasMixedFillColor).toBe(false);
			expect(result.current.hasMixedStrokeColor).toBe(false);
		});
	});

	describe("when multiple elements are selected", () => {
		describe("with different stroke colors", () => {
			it("should report mixed stroke color", () => {
				mockStore = createMockStore({
					selectedElementIds: ["e1", "e2"],
					objects: {
						e1: makeElement("e1", {
							strokeColor: { type: "solid", color: RED },
						}),
						e2: makeElement("e2", {
							strokeColor: { type: "solid", color: BLUE },
						}),
					},
				});

				const { result } = renderHook(() => useActiveColors());

				expect(result.current.hasMixedStrokeColor).toBe(true);
				expect(result.current.currentStrokeFill).toBeNull();
			});
		});

		describe("with different fill colors", () => {
			it("should report mixed fill color", () => {
				mockStore = createMockStore({
					selectedElementIds: ["e1", "e2"],
					objects: {
						e1: makeElement("e1", {
							fill: { type: "solid", color: RED },
						}),
						e2: makeElement("e2", {
							fill: { type: "solid", color: BLUE },
						}),
					},
				});

				const { result } = renderHook(() => useActiveColors());

				expect(result.current.hasMixedFillColor).toBe(true);
				expect(result.current.currentFill).toBeNull();
			});
		});

		describe("with identical colors", () => {
			it("should not report mixed", () => {
				mockStore = createMockStore({
					selectedElementIds: ["e1", "e2"],
					objects: {
						e1: makeElement("e1", {
							strokeColor: { type: "solid", color: RED },
							fill: { type: "solid", color: BLUE },
						}),
						e2: makeElement("e2", {
							strokeColor: { type: "solid", color: RED },
							fill: { type: "solid", color: BLUE },
						}),
					},
				});

				const { result } = renderHook(() => useActiveColors());

				expect(result.current.hasMixedStrokeColor).toBe(false);
				expect(result.current.hasMixedFillColor).toBe(false);
			});
		});
	});
});

// --- Helpers ---

function createMockStore(
	overrides: {
		selectedElementIds?: string[];
		currentLayerId?: string | null;
		layers?: Array<{ id: string }>;
		objects?: Record<string, AnyArtObject>;
	} = {},
) {
	return proxy({
		selectedElementIds: overrides.selectedElementIds ?? [],
		currentLayerId: overrides.currentLayerId ?? "layer-1",
		document: {
			layers: overrides.layers ?? [{ id: "layer-1" }],
			objects: overrides.objects ?? {},
		},
	});
}

function makeElement(
	id: string,
	opts: {
		strokeColor?: { type: "solid"; color: typeof RED };
		fill?: FillColor;
	} = {},
): AnyArtObject {
	const filters: Array<FillAppearance | StrokeAppearance> = [];

	if (opts.strokeColor) {
		filters.push({
			uid: `stroke-${id}`,
			processor: "stroke",
			opacity: 1,
			blendMode: "normal",
			paramData: {
				version: "1",
				params: { strokeColor: opts.strokeColor },
			},
		} satisfies StrokeAppearance);
	}

	if (opts.fill) {
		filters.push({
			uid: `fill-${id}`,
			processor: "fill",
			opacity: 1,
			blendMode: "normal",
			paramData: { version: "1", params: { fill: opts.fill } },
		} satisfies FillAppearance);
	}

	return {
		id,
		type: "path",
		segments: [],
		opacity: 1,
		blendMode: "normal",
		rotation: 0,
		visible: true,
		locked: false,
		filters,
	} as unknown as AnyArtObject;
}
