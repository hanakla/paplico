import {
	type AppConfigRepo,
	type PersistedConfig,
	parsePersistedConfig,
} from "./appConfig";

const CONFIG_FILENAME = "config.yml";

export const tauriAppConfig: AppConfigRepo = {
	async load(): Promise<PersistedConfig> {
		try {
			const { appDataDir } = await import("@tauri-apps/api/path");
			const { exists, readTextFile } = await import("@tauri-apps/plugin-fs");
			const { parse } = await import("@std/yaml");

			const dir = await appDataDir();
			const path = `${dir}/${CONFIG_FILENAME}`;

			console.info(
				`[appConfig] Load config via \`%c${path}%c\``,
				"font-weight:bold",
				"",
			);

			if (!(await exists(path))) return {};

			const text = await readTextFile(path);
			return parsePersistedConfig(parse(text));
		} catch {
			return {};
		}
	},

	async save(config: PersistedConfig): Promise<void> {
		try {
			const { appDataDir } = await import("@tauri-apps/api/path");
			const { exists, mkdir, writeTextFile } = await import(
				"@tauri-apps/plugin-fs"
			);
			const { stringify } = await import("@std/yaml");

			const dir = await appDataDir();
			if (!(await exists(dir))) {
				await mkdir(dir, { recursive: true });
			}

			await writeTextFile(`${dir}/${CONFIG_FILENAME}`, stringify(config));
		} catch (err) {
			console.error("[appConfig] Failed to save config.yml:", err);
		}
	},
};
