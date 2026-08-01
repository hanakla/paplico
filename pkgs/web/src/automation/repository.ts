import { IS_TAURI_ENV } from "@/utils/platform";
import { BUILTIN_AUTOMATION_SCRIPTS } from "./builtins";
import type { AutomationScript, AutomationScriptRepository } from "./types";

const STORAGE_KEY = "paplico:automation-scripts";

export function createAutomationScriptRepository({
	isTauri = IS_TAURI_ENV,
}: {
	isTauri?: boolean;
} = {}): AutomationScriptRepository {
	return new LocalAutomationScriptRepository(isTauri);
}

class LocalAutomationScriptRepository implements AutomationScriptRepository {
	public constructor(public readonly canManageUserScripts: boolean) {}

	public async list(): Promise<AutomationScript[]> {
		return [
			...BUILTIN_AUTOMATION_SCRIPTS,
			...(this.canManageUserScripts ? readUserScripts() : []),
		];
	}

	public async create(input: {
		name: string;
		description: string;
		source: string;
	}): Promise<AutomationScript> {
		this.assertWritable();
		const script: AutomationScript = {
			...input,
			id: `user:${crypto.randomUUID()}`,
			origin: "user",
		};
		writeUserScripts([...readUserScripts(), script]);
		return script;
	}

	public async update(script: AutomationScript): Promise<AutomationScript> {
		this.assertWritable();
		if (script.origin !== "user") {
			throw new Error("Built-in automation scripts are read-only");
		}

		const scripts = readUserScripts();
		const index = scripts.findIndex(({ id }) => id === script.id);
		if (index === -1) {
			throw new Error(`Automation script not found: ${script.id}`);
		}

		writeUserScripts(scripts.with(index, script));
		return script;
	}

	public async delete(id: string): Promise<void> {
		this.assertWritable();
		writeUserScripts(readUserScripts().filter((script) => script.id !== id));
	}

	private assertWritable(): void {
		if (!this.canManageUserScripts) {
			throw new Error(
				"User automation scripts are available only in Paplico Desktop",
			);
		}
	}
}

function readUserScripts(): AutomationScript[] {
	try {
		const value = localStorage.getItem(STORAGE_KEY);
		if (!value) return [];

		return (JSON.parse(value) as AutomationScript[]).filter(
			(script) =>
				script.origin === "user" &&
				typeof script.id === "string" &&
				typeof script.name === "string" &&
				typeof script.description === "string" &&
				typeof script.source === "string",
		);
	} catch {
		return [];
	}
}

function writeUserScripts(scripts: AutomationScript[]): void {
	localStorage.setItem(STORAGE_KEY, JSON.stringify(scripts));
}
