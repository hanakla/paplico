import { fireEvent, render, screen } from "@testing-library/react";
import type { BrushSettings } from "@/core/schema";
import { setLanguage } from "@/hooks/useAppConfig";
import { BrushMatrixSection } from "./BrushMatrixSection";

/**
 * What someone can do to a brush from the panel: switch watercolour or
 * mixing on, drag a base value, and hang an input on a property. Each of
 * those must leave everything they did not touch alone.
 */
describe("BrushMatrixSection", () => {
	beforeEach(() => {
		setLanguage("en");
	});

	it("should keep the watercolour settings hidden until it is switched on", () => {
		render(<BrushMatrixSection settings={dabBrush()} onChange={vi.fn()} />);

		expect(screen.queryByText("Wetness")).toBeNull();

		fireEvent.click(switchOf("Watercolour"));

		// The section only re-renders once the caller feeds the change back,
		// so what the click produced is what the caller was handed.
		expect(screen.queryByText("Wetness")).toBeNull();
	});

	it("should paint a wet stroke as one wash when watercolour is switched on", () => {
		const onChange = vi.fn();
		const settings = dabBrush();
		settings.paintMode = "buildup";
		render(<BrushMatrixSection settings={settings} onChange={onChange} />);

		fireEvent.click(switchOf("Watercolour"));

		const next: BrushSettings = onChange.mock.calls[0][0];
		expect(next.wet?.enabled).toBe(true);
		expect(next.paintMode).toBe("wash");
	});

	it("should show the watercolour properties once it is on", () => {
		const settings = dabBrush();
		settings.wet = {
			enabled: true,
			bleedRadius: 0.5,
			pigmentLoad: 0.85,
			grainScale: 1,
		};

		render(<BrushMatrixSection settings={settings} onChange={vi.fn()} />);

		expect(screen.getByText("Wetness")).toBeTruthy();
		expect(screen.getByText("Bleed")).toBeTruthy();
	});

	it("should keep the mixing settings when it is switched off", () => {
		const onChange = vi.fn();
		const settings = dabBrush();
		settings.mixing = {
			enabled: true,
			mode: "dulling",
			sampleRadius: 2,
			sampleTrail: 1,
			blendStyle: 0.5,
		};
		render(<BrushMatrixSection settings={settings} onChange={onChange} />);

		fireEvent.click(switchOf("Mixing with what is underneath"));

		const next: BrushSettings = onChange.mock.calls[0][0];
		expect(next.mixing).toEqual({
			enabled: false,
			mode: "dulling",
			sampleRadius: 2,
			sampleTrail: 1,
			blendStyle: 0.5,
		});
	});

	it("should switch mixing and watercolour off when the backdrop blur goes on", () => {
		const onChange = vi.fn();
		const settings = dabBrush();
		settings.mixing = {
			enabled: true,
			mode: "dulling",
			sampleRadius: 1,
			sampleTrail: 1,
			blendStyle: 0,
		};
		settings.wet = {
			enabled: true,
			bleedRadius: 0.5,
			pigmentLoad: 0.85,
			grainScale: 1,
		};
		render(<BrushMatrixSection settings={settings} onChange={onChange} />);

		fireEvent.click(switchOf("Blur what is underneath"));

		const next: BrushSettings = onChange.mock.calls[0][0];
		expect(next.backdropBlur?.enabled).toBe(true);
		expect(next.mixing?.enabled).toBe(false);
		expect(next.wet?.enabled).toBe(false);
	});

	it("should not offer watercolour or mixing to engines that ignore them", () => {
		for (const engine of ["ribbon", "geometric"] as const) {
			const settings = dabBrush();
			settings.engine = engine;

			const { unmount } = render(
				<BrushMatrixSection settings={settings} onChange={vi.fn()} />,
			);

			expect(screen.queryByRole("switch", { name: "Watercolour" })).toBeNull();
			expect(
				screen.queryByRole("switch", {
					name: "Mixing with what is underneath",
				}),
			).toBeNull();
			expect(
				screen.queryByRole("switch", { name: "Blur what is underneath" }),
			).toBeNull();
			unmount();
		}
	});

	it("should not offer tip properties for a brush that has no tip", () => {
		const settings = dabBrush();
		settings.engine = "ribbon";

		render(<BrushMatrixSection settings={settings} onChange={vi.fn()} />);

		expect(screen.queryByText("Hardness")).toBeNull();
		expect(screen.getByText("Size")).toBeTruthy();
	});
});

function switchOf(sectionTitle: string): HTMLElement {
	return screen.getByRole("switch", { name: sectionTitle });
}

function dabBrush(): BrushSettings {
	return {
		version: 2,
		engine: "dab",
		strokeOpacity: 1,
		paintMode: "wash",
		properties: { size: { base: 24 } },
		tip: { kind: "procedural", hardness: 1, angleMode: "fixed" },
		randomSeed: 3,
	};
}

/**
 * The panel is what tells someone whether a preset's backdrop blur is on. A
 * preset that carries it must show it as on the moment it is applied.
 */
describe("BrushMatrixSection with a builtin preset", () => {
	beforeEach(() => {
		setLanguage("en");
	});

	it("should show the backdrop blur as on for the blur preset", async () => {
		const { getBuiltinBrushPresets } = await import("@/repos/brushPresets");
		const preset = getBuiltinBrushPresets().find(
			(p) => p.uid === "builtin-brush-blur",
		);
		if (!preset) throw new Error("missing blur preset");

		render(
			<BrushMatrixSection settings={preset.settings} onChange={vi.fn()} />,
		);

		const toggle = screen.getByRole("switch", {
			name: "Blur what is underneath",
		});
		expect(toggle.getAttribute("aria-checked")).toBe("true");
	});
});
