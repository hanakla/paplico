import { createScriptHost } from "@paplico/syrup";
import { describe, expect, it, vi } from "vitest";
import { BUILTIN_AUTOMATION_SCRIPTS } from "@/automation/builtins";
import {
	createScriptPrompt,
	type PaplicoScriptingBridge,
	registerPaplicoScriptingApi,
	type ScriptArtboard,
	type ScriptArtObject,
	type ScriptDocument,
	type ScriptEditor,
} from "./api";

describe("builtin automation scripts", () => {
	it.each(
		BUILTIN_AUTOMATION_SCRIPTS,
	)("should compile $name against the Paplico scripting API", async ({
		source,
	}) => {
		const host = createScriptHost();
		registerPaplicoScriptingApi(host, {
			getActiveDocument: () => {
				throw new Error("Compilation must not access the runtime");
			},
		});

		const output = await host.compile(source);

		expect(
			output.diagnostics.filter(
				(diagnostic) => diagnostic.severity === "error",
			),
		).toEqual([]);
		expect(output.code).not.toBeNull();
	});

	it("should sequentially rename the selected objects", async () => {
		const scene = createScene();

		await runBuiltin("builtin:sequential-rename", scene.bridge);

		expect(scene.first.name).toBe("Object 1");
		expect(scene.second.name).toBe("Object 2");
	});

	it("should randomly transform the selected objects", async () => {
		const random = vi.spyOn(Math, "random").mockReturnValue(0.75);
		const scene = createScene();

		try {
			await runBuiltin("builtin:random-transform", scene.bridge);
		} finally {
			random.mockRestore();
		}

		expect(scene.first.transform).toMatchObject({
			x: 25,
			y: 25,
			rotation: 7.5,
		});
		expect(scene.second.transform).toMatchObject({
			x: 125,
			y: 225,
			rotation: 7.5,
		});
	});

	it("should round the selected object coordinates", async () => {
		const scene = createScene();
		scene.first.transform.x = 10.4;
		scene.first.transform.y = -20.6;
		scene.second.transform.x = 99.5;
		scene.second.transform.y = 200.49;

		await runBuiltin("builtin:round-coordinates", scene.bridge);

		expect(scene.first.transform).toMatchObject({ x: 10, y: -21 });
		expect(scene.second.transform).toMatchObject({ x: 100, y: 200 });
	});

	it("should replace selected text without changing run styles", async () => {
		const scene = createScene();
		const regularStyle = createTextStyle(400);
		const boldStyle = createTextStyle(700);
		Object.assign(scene.first, {
			type: "text",
			content: {
				paragraphs: [
					{
						runs: [
							{ text: "Say Hel", style: regularStyle },
							{ text: "lo world", style: boldStyle },
						],
						alignment: "left",
						lineHeight: 1,
						indent: 0,
						spacing: { before: 0, after: 0 },
					},
				],
			},
		});

		await runBuiltin("builtin:replace-selected-text", scene.bridge, [
			"Hello",
			"Goodbye",
		]);

		expect(scene.first.content?.paragraphs[0]?.runs).toEqual([
			{ text: "Say Goo", style: regularStyle },
			{ text: "dbye world", style: boldStyle },
		]);

		await runBuiltin("builtin:replace-selected-text", scene.bridge, [
			"Goodbye",
			"Hi",
		]);

		expect(scene.first.content?.paragraphs[0]?.runs).toEqual([
			{ text: "Say Hi", style: regularStyle },
			{ text: " world", style: boldStyle },
		]);
	});

	it("should swap the positions of two selected objects", async () => {
		const scene = createScene();

		await runBuiltin("builtin:swap-positions", scene.bridge);

		expect(scene.first.transform).toMatchObject({ x: 100, y: 200 });
		expect(scene.second.transform).toMatchObject({ x: 0, y: 0 });
	});
});

async function runBuiltin(
	id: string,
	bridge: PaplicoScriptingBridge,
	promptResponses: string[] = [],
): Promise<void> {
	const script = BUILTIN_AUTOMATION_SCRIPTS.find(
		(candidate) => candidate.id === id,
	);
	if (!script) throw new Error(`Missing built-in automation script: ${id}`);

	const host = createScriptHost();
	registerPaplicoScriptingApi(
		host,
		bridge,
		createScriptPrompt(async () => promptResponses.shift() ?? null),
	);
	await host.runSource(script.source);
}

function createScene(): {
	first: ScriptArtObject;
	second: ScriptArtObject;
	artboard: ScriptArtboard;
	bridge: PaplicoScriptingBridge;
} {
	const first = createArtObject({
		uid: "first",
		x: 0,
		y: 0,
		bounds: {
			x: 60,
			y: 45,
			width: 100,
			height: 50,
			minX: 10,
			minY: 20,
			maxX: 110,
			maxY: 70,
		},
	});
	const second = createArtObject({
		uid: "second",
		x: 100,
		y: 200,
		bounds: {
			x: -25,
			y: 12.5,
			width: 10,
			height: 15,
			minX: -30,
			minY: 5,
			maxX: -20,
			maxY: 20,
		},
	});
	const artboard: ScriptArtboard = {
		uid: "artboard",
		name: "Artboard",
		x: 0,
		y: 0,
		width: 1,
		height: 1,
	};
	const objects = [first, second];
	const editor: ScriptEditor = {
		selection: objects,
		select: () => {},
		clearSelection: () => {},
	};
	const document: ScriptDocument = {
		uid: "document",
		title: "Document",
		viewport: { x: 0, y: 0, zoom: 1, rotation: 0 },
		schemaVersion: undefined,
		hdr: undefined,
		colorProfile: undefined,
		rasterizationDpi: undefined,
		findArtObject: (uid) => objects.find((object) => object.uid === uid),
		artObjects: () => objects,
		findLayer: () => null,
		layers: () => [],
		findArtboard: (uid) => (uid === artboard.uid ? artboard : null),
		artboards: () => [artboard],
	};

	return {
		first,
		second,
		artboard,
		bridge: {
			getActiveDocument: () => document,
			getEditor: () => editor,
		},
	};
}

function createArtObject({
	uid,
	x,
	y,
	bounds,
}: {
	uid: string;
	x: number;
	y: number;
	bounds: {
		x: number;
		y: number;
		width: number;
		height: number;
		minX: number;
		minY: number;
		maxX: number;
		maxY: number;
	};
}): ScriptArtObject {
	return Object.assign(
		{
			uid,
			type: "path" as const,
			name: uid,
			visible: true,
			locked: false,
			opacity: 1,
			blendMode: "normal" as const,
			transform: {
				x,
				y,
				rotation: 0,
				scaleX: 1,
				scaleY: 1,
			},
			childIds: [],
			objectIds: [],
		},
		{ bounds },
	);
}

function createTextStyle(fontWeight: number) {
	return {
		fontFamily: "Inter",
		fontSource: { type: "local" as const, postScriptName: "Inter" },
		fontSize: 16,
		fontWeight,
		fontStyle: "normal" as const,
		fill: null,
		underline: false,
		strikethrough: false,
		letterSpacing: 0,
		baselineShift: 0,
	};
}
