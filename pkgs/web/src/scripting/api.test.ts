import { createScriptHost, LanguageService } from "@paplico/syrup";
import { describe, expect, it } from "vitest";
import {
	createScriptPrompt,
	registerPaplicoScriptingApi,
	type ScriptArtObject,
	type ScriptAutomationFile,
	type ScriptDocument,
	type ScriptDocumentDirectory,
} from "./api";

describe("registerPaplicoScriptingApi", () => {
	it("should expose the active document and write through var members", async () => {
		const lines: string[] = [];
		const host = createScriptHost({ stdout: (text) => lines.push(text) });
		const { rect, bridge } = makeBridge();
		registerPaplicoScriptingApi(host, bridge);
		await host.runSource(`
			let doc = paplico.activeDocument
			print(doc.title)
			if let obj = doc.findArtObject(uid: "rect-1") {
				obj.opacity = 0.5
				print("$(obj.name): $(obj.opacity)")
			}
			print(doc.artObjects().count)
		`);
		expect(lines).toEqual(["Sample", "Rect: 0.5", "1"]);
		expect(rect.opacity).toBe(0.5);
	});

	it("should return nil for unknown art objects", async () => {
		const lines: string[] = [];
		const host = createScriptHost({ stdout: (text) => lines.push(text) });
		registerPaplicoScriptingApi(host, makeBridge().bridge);
		await host.runSource(`
			if let obj = paplico.activeDocument.findArtObject(uid: "missing") {
				print(obj.name)
			} else {
				print("not found")
			}
		`);
		expect(lines).toEqual(["not found"]);
	});

	it("should write through a destination chosen with saveFile", async () => {
		const lines: string[] = [];
		const written: string[] = [];
		const host = createScriptHost({ stdout: (text) => lines.push(text) });
		const savedFile: ScriptAutomationFile = {
			name: "export.txt",
			readText: async () => "",
			readBytes: async () => [],
			writeText: async (contents) => {
				written.push(contents);
			},
			writeBytes: async () => {},
		};
		registerPaplicoScriptingApi(host, {
			...makeBridge().bridge,
			getFileSystem: () => ({
				documentDirectory: null,
				openFiles: async () => [],
				saveFile: async (fileName) => ({
					...savedFile,
					name: fileName ?? savedFile.name,
				}),
				dispose: async () => {},
			}),
		});

		await host.runSource(`
			if let fs = paplico.getFileSystem() {
				if let file = await fs.saveFile(fileName: "result.txt") {
					await file.writeText(content: "done")
					print(file.name)
				}
			}
		`);

		expect(lines).toEqual(["result.txt"]);
		expect(written).toEqual(["done"]);
	});

	it("should create directories under the document directory without prompting", async () => {
		const lines: string[] = [];
		const created: string[] = [];
		const written: Array<[string, string]> = [];
		const host = createScriptHost({ stdout: (text) => lines.push(text) });
		const makeDirectory = (prefix: string): ScriptDocumentDirectory => ({
			file: async (path, create) =>
				create
					? {
							name: path,
							readText: async () => "",
							readBytes: async () => [],
							writeText: async (contents) => {
								written.push([`${prefix}${path}`, contents]);
							},
							writeBytes: async () => {},
						}
					: null,
			createDirectory: async (path) => {
				created.push(path);
				return makeDirectory(`${prefix}${path}/`);
			},
		});
		registerPaplicoScriptingApi(host, {
			...makeBridge().bridge,
			getFileSystem: () => ({
				documentDirectory: makeDirectory(""),
				openFiles: async () => [],
				saveFile: async () => null,
				dispose: async () => {},
			}),
		});

		await host.runSource(`
			if let fs = paplico.getFileSystem() {
				if let dir = fs.documentDirectory {
					let exports = await dir.createDirectory(path: "exports")
					if await exports.file(path: "note.txt") == nil {
						print("not there yet")
					}
					if let note = await exports.file(path: "note.txt", create: true) {
						await note.writeText(content: "hi")
						print("saved")
					}
				}
			}
		`);

		expect(lines).toEqual(["not there yet", "saved"]);
		expect(created).toEqual(["exports"]);
		expect(written).toEqual([["exports/note.txt", "hi"]]);
	});

	it("should provide paplico package completions without a runtime bridge", async () => {
		const host = createScriptHost();
		registerPaplicoScriptingApi(host);
		const service = new LanguageService(host);
		const source = "paplico.";

		await service.update(source);

		expect(
			service.completionsAt(source.length).map(({ label }) => label),
		).toEqual(
			expect.arrayContaining([
				"activeDocument",
				"editor",
				"prompt",
				"getFileSystem",
			]),
		);

		const promptSource = "paplico.prompt.";
		await service.update(promptSource);

		expect(
			service.completionsAt(promptSource.length).map(({ label }) => label),
		).toEqual(expect.arrayContaining(["alert", "confirm"]));
	});

	it("should complete schema-backed document and art object fields", async () => {
		const host = createScriptHost();
		registerPaplicoScriptingApi(host);
		const service = new LanguageService(host);
		const documentSource = "let document = paplico.activeDocument\ndocument.";

		await service.update(documentSource);

		expect(
			service.completionsAt(documentSource.length).map(({ label }) => label),
		).toEqual(
			expect.arrayContaining([
				"viewport",
				"schemaVersion",
				"hdr",
				"colorProfile",
				"rasterizationDpi",
			]),
		);

		const objectSource = `
			if let object = paplico.activeDocument.findArtObject(uid: "item") {
				object.`;
		await service.update(objectSource);

		expect(
			service.completionsAt(objectSource.length).map(({ label }) => label),
		).toEqual(
			expect.arrayContaining([
				"blendMode",
				"compositionMode",
				"filters",
				"segments",
				"childIds",
				"fileUid",
				"sources",
				"content",
				"vertices",
				"objectIds",
				"sceneId",
			]),
		);
	});

	it("should await prompt responses and return nil when a prompt is cancelled", async () => {
		const lines: string[] = [];
		const alerts: string[] = [];
		const host = createScriptHost({ stdout: (text) => lines.push(text) });
		registerPaplicoScriptingApi(host, makeBridge().bridge, {
			alert: async (message) => {
				alerts.push(message);
			},
			confirm: async () => true,
			string: async () => "Layer name",
			number: async () => 42,
			boolean: async () => false,
			choice: async () => null,
		});

		await host.runSource(`
			await paplico.prompt.alert(message: "Saved")
			print(await paplico.prompt.confirm(message: "Continue?"))
			if let name = await paplico.prompt.string(message: "Name", defaultValue: "") {
				print(name)
			}
			if let amount = await paplico.prompt.number(message: "Amount", defaultValue: 0) {
				print(amount)
			}
			if let enabled = await paplico.prompt.boolean(message: "Enabled", defaultValue: true) {
				print(enabled)
			}
			if let choice = await paplico.prompt.choice(message: "Choice", choices: ["A", "B"], defaultValue: "A") {
				print(choice)
			} else {
				print("cancelled")
			}
		`);

		expect(alerts).toEqual(["Saved"]);
		expect(lines).toEqual(["true", "Layer name", "42", "false", "cancelled"]);
	});

	it("should map alert and confirm requests to the prompt handler", async () => {
		const requests: unknown[] = [];
		const prompt = createScriptPrompt(async (request) => {
			requests.push(request);
			return request.kind === "confirm";
		});

		await expect(prompt.alert("Saved")).resolves.toBeUndefined();
		await expect(prompt.confirm("Continue?")).resolves.toBe(true);

		expect(requests).toEqual([
			{ kind: "alert", message: "Saved" },
			{ kind: "confirm", message: "Continue?" },
		]);
	});
});

function makeBridge(): {
	rect: ScriptArtObject;
	bridge: { getActiveDocument(): ScriptDocument };
} {
	const rect: ScriptArtObject = {
		uid: "rect-1",
		type: "path",
		name: "Rect",
		visible: true,
		locked: false,
		opacity: 1,
		blendMode: "normal",
		transform: {
			x: 0,
			y: 0,
			rotation: 0,
			scaleX: 1,
			scaleY: 1,
		},
		bounds: {
			x: 0,
			y: 0,
			minX: -5,
			minY: -5,
			maxX: 5,
			maxY: 5,
			width: 10,
			height: 10,
		},
	};
	const doc: ScriptDocument = {
		uid: "doc-1",
		title: "Sample",
		viewport: { x: 0, y: 0, zoom: 1, rotation: 0 },
		schemaVersion: undefined,
		hdr: undefined,
		colorProfile: undefined,
		rasterizationDpi: undefined,
		findArtObject: (uid) => (uid === rect.uid ? rect : null),
		artObjects: () => [rect],
		findLayer: () => null,
		layers: () => [],
		findArtboard: () => null,
		artboards: () => [],
	};
	return { rect, bridge: { getActiveDocument: () => doc } };
}
