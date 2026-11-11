import {
	isNetworkPath,
	resolveLinkedSourcePath,
	toLinkedSourcePath,
} from "./linkedFiles.tauri";

describe("toLinkedSourcePath", () => {
	it("should keep the absolute path while the document has no file", () => {
		expect(toLinkedSourcePath("/Users/me/art/ref.png", null)).toBe(
			"/Users/me/art/ref.png",
		);
	});

	it("should return a path relative to the folder of the document", () => {
		expect(
			toLinkedSourcePath("/Users/me/art/img/ref.png", "/Users/me/art/doc.papf"),
		).toBe("img/ref.png");
	});

	it("should climb out of the document folder with ..", () => {
		expect(
			toLinkedSourcePath("/Users/me/photos/ref.png", "/Users/me/art/doc.papf"),
		).toBe("../photos/ref.png");
	});

	it("should keep the absolute path for a file on another drive", () => {
		expect(toLinkedSourcePath("D:\\photos\\ref.png", "C:\\art\\doc.papf")).toBe(
			"D:\\photos\\ref.png",
		);
	});

	it("should write a Windows relative path with / separators", () => {
		expect(
			toLinkedSourcePath("C:\\art\\img\\ref.png", "C:\\art\\doc.papf"),
		).toBe("img/ref.png");
	});
});

describe("resolveLinkedSourcePath", () => {
	it("should return an absolute path as it is", () => {
		expect(resolveLinkedSourcePath("/Users/me/ref.png", null)).toBe(
			"/Users/me/ref.png",
		);
	});

	it("should return null for a relative path while the document has no file", () => {
		expect(resolveLinkedSourcePath("img/ref.png", null)).toBeNull();
	});

	it("should resolve a relative path from the folder of the document", () => {
		expect(
			resolveLinkedSourcePath("../photos/ref.png", "/Users/me/art/doc.papf"),
		).toBe("/Users/me/photos/ref.png");
	});

	it("should give back the path toLinkedSourcePath was made from", () => {
		const documentPath = "/Users/me/art/doc.papf";
		const filePath = "/Users/me/photos/2026/ref.png";
		expect(
			resolveLinkedSourcePath(
				toLinkedSourcePath(filePath, documentPath),
				documentPath,
			),
		).toBe(filePath);
	});
});

describe("isNetworkPath", () => {
	it("should name paths that start at another machine", () => {
		expect(isNetworkPath("\\\\server\\share\\a.png")).toBe(true);
		expect(isNetworkPath("//server/share/a.png")).toBe(true);
	});

	it("should leave local absolute and relative paths alone", () => {
		expect(isNetworkPath("/Users/me/a.png")).toBe(false);
		expect(isNetworkPath("C:\\art\\a.png")).toBe(false);
		expect(isNetworkPath("../img/a.png")).toBe(false);
	});
});

describe("resolveLinkedSourcePath for a document on a shared folder", () => {
	it("should resolve a relative path from the folder of the document", () => {
		expect(
			resolveLinkedSourcePath("img/a.png", "\\\\server\\share\\doc.papf"),
		).toBe("//server/share/img/a.png");
	});
});
