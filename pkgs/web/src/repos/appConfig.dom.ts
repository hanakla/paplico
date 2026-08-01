import {
	type AppConfigRepo,
	type PersistedConfig,
	parsePersistedConfig,
} from "./appConfig";

const STORAGE_KEY = "paplico:appSettings";

export const domAppConfig: AppConfigRepo = {
	async load(): Promise<PersistedConfig> {
		if (typeof localStorage === "undefined") return {};

		try {
			const raw = localStorage.getItem(STORAGE_KEY);
			if (!raw) return {};
			return parsePersistedConfig(JSON.parse(raw));
		} catch {
			return {};
		}
	},

	async save(config: PersistedConfig): Promise<void> {
		if (typeof localStorage === "undefined") return;
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
		} catch {
			console.warn("[appConfig] Failed to persist config to localStorage");
		}
	},
};
