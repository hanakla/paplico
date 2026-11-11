import type { Paplico } from "@paplico/core";
import type { Document } from "@paplico/core/schema";
import { proxy } from "valtio";
import { readLinkedImage, statLinkedImages } from "@/infra/linkedFiles.tauri";
import {
	documentSessionState,
	setSnapshotDocumentSession,
} from "./documentSessionStore";
import {
	checkLinkedFiles,
	collectAssetElementIds,
	collectAssetFileUids,
	linkedFilesState,
} from "./linkedFilesStore";

vi.mock("@/infra/linkedFiles.tauri", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/infra/linkedFiles.tauri")>()),
	readLinkedImage: vi.fn(),
	statLinkedImages: vi.fn(),
}));

describe("collectAssetFileUids", () => {
	it("should collect the files of images and 3D models, and leave brush textures out", () => {
		const document = {
			objects: {
				image: { id: "image", type: "image", fileUid: "file-image" },
				view: { id: "view", type: "reference3d", sceneId: "scene" },
				stroke: {
					id: "stroke",
					type: "path",
					brushSettings: {
						tipSource: { kind: "file", fileUid: "file-brush" },
					},
				},
			},
			references3d: {
				scene: {
					id: "scene",
					nodes: [
						{ id: "box", kind: "primitive", shape: "box" },
						{ id: "figure", kind: "figure", fileUid: "file-vrm" },
						{ id: "mesh", kind: "mesh", fileUid: "file-glb" },
					],
				},
			},
		} as unknown as Document;

		expect([...collectAssetFileUids(document)].sort()).toEqual([
			"file-glb",
			"file-image",
			"file-vrm",
		]);
	});

	it("should leave out the models of a 3D scene no element shows", () => {
		const document = {
			objects: {},
			references3d: {
				scene: {
					id: "scene",
					nodes: [{ id: "figure", kind: "figure", fileUid: "file-vrm" }],
				},
			},
		} as unknown as Document;

		expect([...collectAssetFileUids(document)]).toEqual([]);
	});
});

describe("collectAssetElementIds", () => {
	const document = {
		objects: {
			a: { id: "a", type: "image", fileUid: "file-image" },
			b: { id: "b", type: "image", fileUid: "file-other" },
			c: { id: "c", type: "image", fileUid: "file-image" },
			view: { id: "view", type: "reference3d", sceneId: "scene" },
		},
		references3d: {
			scene: {
				id: "scene",
				nodes: [{ id: "figure", kind: "figure", fileUid: "file-vrm" }],
			},
		},
	} as unknown as Document;

	it("should return every image that shows the file", () => {
		expect(collectAssetElementIds(document, "file-image")).toEqual(["a", "c"]);
	});

	it("should return the 3D elements whose scene holds the file", () => {
		expect(collectAssetElementIds(document, "file-vrm")).toEqual(["view"]);
	});
});

describe("checkLinkedFiles", () => {
	const linkedFile = {
		uid: "file-linked",
		name: "ref.png",
		type: "image/png",
		hash: "hash-old",
		bin: new Uint8Array([1]),
		sourcePath: "/Users/me/ref.png",
	};

	function createPaplico(
		files: Array<typeof linkedFile>,
		imageFileUids: string[],
	): Paplico {
		return {
			uiState: proxy({
				document: {
					files,
					objects: Object.fromEntries(
						imageFileUids.map((fileUid, index) => [
							`image-${index}`,
							{ id: `image-${index}`, type: "image", fileUid },
						]),
					),
				},
			}),
		} as unknown as Paplico;
	}

	function sourceFile(): File {
		return new File([new Uint8Array([2])], "ref.png", { type: "image/png" });
	}

	beforeEach(() => {
		linkedFilesState.status = {};
		setSnapshotDocumentSession();
		vi.mocked(readLinkedImage).mockReset().mockResolvedValue(sourceFile());
		vi.mocked(statLinkedImages)
			.mockReset()
			.mockImplementation(async (paths) =>
				paths.map(() => ({ modifiedAt: 1, size: 1 })),
			);
	});

	it("should report a linked file whose source holds other bytes", async () => {
		const changed = await checkLinkedFiles(
			createPaplico([linkedFile], ["file-linked"]),
		);

		expect(changed.map(({ file }) => file.uid)).toEqual(["file-linked"]);
		expect(linkedFilesState.status).toEqual({ "file-linked": "changed" });
	});

	it("should mark a linked file whose source cannot be read as missing", async () => {
		vi.mocked(statLinkedImages).mockResolvedValue([null]);

		const changed = await checkLinkedFiles(
			createPaplico([linkedFile], ["file-linked"]),
		);

		expect(changed).toEqual([]);
		expect(linkedFilesState.status).toEqual({ "file-linked": "missing" });
		expect(readLinkedImage).not.toHaveBeenCalled();
	});

	it("should leave out a linked file no element uses", async () => {
		const changed = await checkLinkedFiles(createPaplico([linkedFile], []));

		expect(changed).toEqual([]);
		expect(linkedFilesState.status).toEqual({});
		expect(statLinkedImages).toHaveBeenCalledWith([]);
	});

	it("should not read a source whose date and size are as they were", async () => {
		const paplico = createPaplico([linkedFile], ["file-linked"]);
		await checkLinkedFiles(paplico);

		const changed = await checkLinkedFiles(paplico);

		expect(readLinkedImage).toHaveBeenCalledTimes(1);
		expect(changed.map(({ file }) => file.uid)).toEqual(["file-linked"]);
	});

	it("should read a source again once its date changed", async () => {
		const paplico = createPaplico([linkedFile], ["file-linked"]);
		await checkLinkedFiles(paplico);
		vi.mocked(statLinkedImages).mockResolvedValue([{ modifiedAt: 2, size: 1 }]);

		await checkLinkedFiles(paplico);

		expect(readLinkedImage).toHaveBeenCalledTimes(2);
	});

	it("should never read a stored path that starts at another machine", async () => {
		const changed = await checkLinkedFiles(
			createPaplico(
				[{ ...linkedFile, sourcePath: "\\\\server\\share\\ref.png" }],
				["file-linked"],
			),
		);

		expect(changed).toEqual([]);
		expect(linkedFilesState.status).toEqual({ "file-linked": "missing" });
		expect(statLinkedImages).toHaveBeenCalledWith([]);
		expect(readLinkedImage).not.toHaveBeenCalled();
	});

	it("should record and report nothing when another document opens during the check", async () => {
		vi.mocked(readLinkedImage).mockImplementation(async () => {
			setSnapshotDocumentSession();
			return null;
		});
		const identity = documentSessionState.identity;

		const changed = await checkLinkedFiles(
			createPaplico([linkedFile], ["file-linked"]),
		);

		expect(documentSessionState.identity).not.toBe(identity);
		expect(changed).toEqual([]);
		expect(linkedFilesState.status).toEqual({});
	});
});
