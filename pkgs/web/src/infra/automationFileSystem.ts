import type { FileHandle } from "@/infra/filesystem";
import { IS_TAURI_ENV } from "@/utils/platform";

export interface AutomationFile {
	readonly name: string;
	readText(): Promise<string>;
	readBytes(): Promise<number[]>;
	writeText(contents: string): Promise<void>;
	writeBytes(contents: readonly number[]): Promise<void>;
}

export interface AutomationDirectory {
	/**
	 * Handle for a file in this directory, or null when it does not exist.
	 * Pass `create` to make a missing file (and its parents) instead.
	 */
	file(path: string, create?: boolean): Promise<AutomationFile | null>;
	/** Creates the directory and its parents, then hands back a handle to it. */
	createDirectory(path: string): Promise<AutomationDirectory>;
}

export interface AutomationFileSystem {
	readonly documentDirectory: AutomationDirectory | null;
	openFiles(options?: { extensions?: string[] }): Promise<AutomationFile[]>;
	/** Asks for a destination. Resolves to null when the user cancels. */
	saveFile(
		fileName?: string,
		extensions?: readonly string[],
	): Promise<AutomationFile | null>;
	dispose(): Promise<void>;
}

type Invoke = <T>(
	command: string,
	args?: Record<string, unknown>,
) => Promise<T>;

type FileDescriptor = {
	token: string;
	name: string;
};

export async function createAutomationFileSystem(
	currentDocumentHandle?: FileHandle | null,
	{
		isTauri = IS_TAURI_ENV,
		invoke: providedInvoke,
	}: {
		isTauri?: boolean;
		invoke?: Invoke;
	} = {},
): Promise<AutomationFileSystem | null> {
	if (!isTauri) return null;

	const invoke =
		providedInvoke ?? (await import("@tauri-apps/api/core")).invoke;
	const directoryToken =
		typeof currentDocumentHandle?.handle === "string"
			? await invoke<string | null>("automation_register_document_directory", {
					documentPath: currentDocumentHandle.handle,
				})
			: null;

	return new TauriAutomationFileSystem(invoke, directoryToken);
}

class TauriAutomationFileSystem implements AutomationFileSystem {
	private readonly tokens = new Set<string>();
	public readonly documentDirectory: AutomationDirectory | null;

	public constructor(
		private readonly invoke: Invoke,
		directoryToken: string | null,
	) {
		this.documentDirectory = directoryToken
			? new TauriAutomationDirectory(invoke, directoryToken, this.tokens)
			: null;
		if (directoryToken) this.tokens.add(directoryToken);
	}

	public async openFiles({
		extensions,
	}: {
		extensions?: string[];
	} = {}): Promise<AutomationFile[]> {
		const descriptors = await this.invoke<FileDescriptor[]>(
			"automation_open_files",
			{ extensions },
		);
		return descriptors.map(({ token, name }) => {
			this.tokens.add(token);
			return new TauriAutomationFile(this.invoke, token, name);
		});
	}

	public async saveFile(
		fileName?: string,
		extensions?: readonly string[],
	): Promise<AutomationFile | null> {
		const descriptor = await this.invoke<FileDescriptor | null>(
			"automation_save_file",
			{ fileName, extensions },
		);
		if (!descriptor) return null;
		this.tokens.add(descriptor.token);
		return new TauriAutomationFile(
			this.invoke,
			descriptor.token,
			descriptor.name,
		);
	}

	public async dispose(): Promise<void> {
		await Promise.all(
			this.tokens
				.values()
				.map((token) => this.invoke("automation_revoke_access", { token })),
		);
		this.tokens.clear();
	}
}

class TauriAutomationFile implements AutomationFile {
	public constructor(
		private readonly invoke: Invoke,
		private readonly token: string,
		public readonly name: string,
	) {}

	public async readText(): Promise<string> {
		return new TextDecoder().decode(Uint8Array.from(await this.readBytes()));
	}

	public async readBytes(): Promise<number[]> {
		return this.invoke<number[]>("automation_read_file", {
			token: this.token,
		});
	}

	public async writeText(contents: string): Promise<void> {
		await this.writeBytes(Array.from(new TextEncoder().encode(contents)));
	}

	public async writeBytes(contents: readonly number[]): Promise<void> {
		assertBytes(contents);
		await this.invoke("automation_write_file", {
			token: this.token,
			bytes: contents,
		});
	}
}

class TauriAutomationDirectory implements AutomationDirectory {
	public constructor(
		private readonly invoke: Invoke,
		private readonly token: string,
		private readonly tokens: Set<string>,
	) {}

	public async file(
		path: string,
		create?: boolean,
	): Promise<AutomationFile | null> {
		const descriptor = await this.invoke<FileDescriptor | null>(
			"automation_directory_file",
			{ token: this.token, relativePath: path, create },
		);
		if (!descriptor) return null;
		this.tokens.add(descriptor.token);
		return new TauriAutomationFile(
			this.invoke,
			descriptor.token,
			descriptor.name,
		);
	}

	public async createDirectory(path: string): Promise<AutomationDirectory> {
		const token = await this.invoke<string>("automation_create_directory", {
			token: this.token,
			relativePath: path,
		});
		this.tokens.add(token);
		return new TauriAutomationDirectory(this.invoke, token, this.tokens);
	}
}

function assertBytes(contents: readonly number[]): void {
	if (
		contents.some(
			(value) => !Number.isInteger(value) || value < 0 || value > 255,
		)
	) {
		throw new RangeError(
			"Binary file contents must contain bytes from 0 to 255",
		);
	}
}
