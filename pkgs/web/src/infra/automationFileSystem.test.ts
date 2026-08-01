import { describe, expect, it } from "vitest";
import { createAutomationFileSystem } from "@/infra/automationFileSystem";
import type { FileHandle } from "@/infra/filesystem";

describe("createAutomationFileSystem", () => {
	it("should return null when Tauri capabilities are unavailable", async () => {
		await expect(createAutomationFileSystem()).resolves.toBeNull();
	});

	it("should reject invalid byte values before invoking Tauri", async () => {
		const calls: Array<{ command: string; args?: Record<string, unknown> }> =
			[];
		const fileSystem = await createAutomationFileSystem(null, {
			isTauri: true,
			invoke: createInvoke(calls),
		});
		const [file] = (await fileSystem?.openFiles()) ?? [];

		await expect(file?.writeBytes([0, 255, 256])).rejects.toThrow(
			"must contain bytes from 0 to 255",
		);
		expect(
			calls.filter(({ command }) => command === "automation_write_file"),
		).toEqual([]);
	});

	it("should expose the chosen destination as a writable file", async () => {
		const calls: Array<{ command: string; args?: Record<string, unknown> }> =
			[];
		const fileSystem = await createAutomationFileSystem(null, {
			isTauri: true,
			invoke: createInvoke(calls),
		});

		const file = await fileSystem?.saveFile("export.txt", [".txt"]);
		await file?.writeText("done");

		expect(file?.name).toBe("export.txt");
		expect(
			calls.find(({ command }) => command === "automation_save_file")?.args,
		).toEqual({ fileName: "export.txt", extensions: [".txt"] });
		expect(
			calls.find(({ command }) => command === "automation_write_file")?.args,
		).toEqual({
			token: "saved-token",
			bytes: Array.from(new TextEncoder().encode("done")),
		});
	});

	it("should resolve to null when a file is missing and create was not asked for", async () => {
		const calls: Array<{ command: string; args?: Record<string, unknown> }> =
			[];
		const fileSystem = await createAutomationFileSystem(
			{
				handle: "/documents/sample.papf",
				file: new File([], "sample.papf"),
			} as FileHandle,
			{
				isTauri: true,
				invoke: async <T>(command: string, args?: Record<string, unknown>) => {
					calls.push({ command, args });
					if (command === "automation_register_document_directory") {
						return "directory-token" as T;
					}
					return (
						command === "automation_directory_file" ? null : undefined
					) as T;
				},
			},
		);

		await expect(
			fileSystem?.documentDirectory?.file("missing.txt"),
		).resolves.toBeNull();
		expect(
			calls.find(({ command }) => command === "automation_directory_file")
				?.args,
		).toEqual({
			token: "directory-token",
			relativePath: "missing.txt",
			create: undefined,
		});
	});

	it("should resolve to null when the save dialog is cancelled", async () => {
		const fileSystem = await createAutomationFileSystem(null, {
			isTauri: true,
			invoke: async <T>(command: string): Promise<T> =>
				(command === "automation_save_file" ? null : undefined) as T,
		});

		await expect(fileSystem?.saveFile()).resolves.toBeNull();
	});

	it("should create directories and files under the document directory", async () => {
		const calls: Array<{ command: string; args?: Record<string, unknown> }> =
			[];
		const fileSystem = await createAutomationFileSystem(
			{
				handle: "/documents/sample.papf",
				file: new File([], "sample.papf"),
			} as FileHandle,
			{ isTauri: true, invoke: createInvoke(calls) },
		);

		const nested =
			await fileSystem?.documentDirectory?.createDirectory("exports/renders");
		const file = await nested?.file("note.txt", true);
		await file?.writeText("hi");

		expect(
			calls.find(({ command }) => command === "automation_create_directory")
				?.args,
		).toEqual({ token: "directory-token", relativePath: "exports/renders" });
		expect(
			calls.find(({ command }) => command === "automation_directory_file")
				?.args,
		).toEqual({
			token: "nested-directory-token",
			relativePath: "note.txt",
			create: true,
		});
		expect(
			calls.find(({ command }) => command === "automation_write_file")?.args,
		).toEqual({
			token: "nested-file-token",
			bytes: Array.from(new TextEncoder().encode("hi")),
		});
	});

	it("should revoke selected-file and document-directory access on dispose", async () => {
		const calls: Array<{ command: string; args?: Record<string, unknown> }> =
			[];
		const fileSystem = await createAutomationFileSystem(
			{
				handle: "/documents/sample.papf",
				file: new File([], "sample.papf"),
			} as FileHandle,
			{
				isTauri: true,
				invoke: createInvoke(calls),
			},
		);
		await fileSystem?.openFiles();

		await fileSystem?.dispose();

		expect(
			calls
				.filter(({ command }) => command === "automation_revoke_access")
				.map(({ args }) => args?.token),
		).toEqual(["directory-token", "file-token"]);
	});
});

function createInvoke(
	calls: Array<{ command: string; args?: Record<string, unknown> }>,
): <T>(command: string, args?: Record<string, unknown>) => Promise<T> {
	return async <T>(
		command: string,
		args?: Record<string, unknown>,
	): Promise<T> => {
		calls.push({ command, args });
		const result = (() => {
			switch (command) {
				case "automation_register_document_directory":
					return "directory-token";
				case "automation_open_files":
					return [{ token: "file-token", name: "sample.bin" }];
				case "automation_save_file":
					return { token: "saved-token", name: "export.txt" };
				case "automation_create_directory":
					return "nested-directory-token";
				case "automation_directory_file":
					return { token: "nested-file-token", name: "note.txt" };
				default:
					return undefined;
			}
		})();
		return result as T;
	};
}
