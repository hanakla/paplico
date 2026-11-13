import type { FontMetadata } from "@paplico/core/typography";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FontCombobox } from "./FontCombobox";

const fontManager = {
	loaders: new Map(),
	getLocalizedNames: vi.fn(),
	getFontScripts: vi.fn(),
	queryAllFonts: vi.fn(async () => []),
	on: vi.fn(),
};

vi.mock("@/contexts/PaplicoContext", () => ({
	usePaplico: () => ({ fonts: fontManager }),
}));

vi.mock("@/hooks/useAppConfig", () => ({
	useAppConfig: () => ({ language: "ja" }),
}));

vi.mock("@/locales", () => ({
	useTranslation: () => (key: string) => key,
}));

afterEach(cleanup);

describe("FontCombobox", () => {
	it("shows the current font before the picker is opened", () => {
		const font = makeFont("Noto Sans");
		const view = render(fontPicker([font], font));

		expect((view.getByRole("combobox") as HTMLInputElement).value).toBe(
			"Noto Sans",
		);
	});

	it("shows the family name separately from the localized face name", () => {
		const font = {
			...makeFont("Noto Sans JP"),
			localizedFamily: "源ノ角ゴシック",
			localizedFullName: "源ノ角ゴシック Regular",
		};
		const view = render(fontPicker([font], font));

		expect((view.getByRole("combobox") as HTMLInputElement).value).toBe(
			font.family,
		);
	});

	it("updates the name when the selected text uses another font", () => {
		const first = makeFont("Noto Sans");
		const second = makeFont("Noto Serif");
		const fonts = [first, second];
		const view = render(fontPicker(fonts, first));

		view.rerender(fontPicker(fonts, second));

		expect((view.getByRole("combobox") as HTMLInputElement).value).toBe(
			second.family,
		);
	});

	it("shows the font name when the font catalog finishes loading", () => {
		const font = makeFont("Noto Sans");
		const view = render(fontPicker([]));

		view.rerender(fontPicker([font], font));

		expect((view.getByRole("combobox") as HTMLInputElement).value).toBe(
			font.family,
		);
	});
});

function fontPicker(fonts: FontMetadata[], currentFont?: FontMetadata) {
	return (
		<FontCombobox
			fonts={fonts}
			currentFont={currentFont}
			isLoading={false}
			onFontChange={vi.fn()}
			previewReady={new Set()}
			previewRef={() => () => {}}
		/>
	);
}

function makeFont(family: string): FontMetadata {
	return {
		family,
		fullName: `${family} Regular`,
		postScriptName: `${family}-Regular`,
		style: "Regular",
		weight: 400,
		loaderId: "test",
		fontId: family,
	};
}
