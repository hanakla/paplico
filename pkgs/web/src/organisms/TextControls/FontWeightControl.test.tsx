import { cleanup, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FontWeightControl } from "./FontWeightControl";

let variable = false;
const font = {
	family: "Example",
	fontId: "Example-Regular",
	loaderId: "local",
	style: "Regular",
	weight: 400,
};
const manager = {
	getVariationAxes: () =>
		variable
			? { wght: { name: "Weight", min: 100, max: 900, default: 400 } }
			: {},
	loadFont: vi.fn(),
};

vi.mock("@/contexts/PaplicoContext", () => ({
	usePaplico: () => ({ fonts: manager }),
}));
vi.mock("@/hooks/useCurrentFontSetting", () => ({
	useActiveFontSettings: () => ({
		currentFont: font,
		currentFontWeight: 400,
		fontFaces: [font],
		handleFontWeightChange: vi.fn(),
	}),
	useFontList: () => ({ loadedVersion: 0 }),
}));
vi.mock("@/locales", () => ({ useTranslation: () => (key: string) => key }));

afterEach(cleanup);

describe("FontWeightControl", () => {
	it.each([
		false,
		true,
	])("keeps the panel label hidden for variable=%s", (isVariable) => {
		variable = isVariable;
		const view = render(
			<>
				<section aria-label="panel">
					<FontWeightControl showLabel={false} />
				</section>
				<section aria-label="context">
					<FontWeightControl />
				</section>
			</>,
		);
		const panel = within(view.getByRole("region", { name: "panel" }));
		const context = within(view.getByRole("region", { name: "context" }));
		const role = isVariable ? "spinbutton" : "combobox";

		expect(panel.queryByText("actionsPanel.weight")).toBeNull();
		expect(panel.getByRole(role, { name: "actionsPanel.weight" })).toBeTruthy();
		expect(context.getByText("actionsPanel.weight")).toBeTruthy();
	});
});
