import { Paplico } from "./Paplico";

type HotReloadState = {
	evalCount: number;
	debounceTimer: ReturnType<typeof setTimeout> | undefined;
	instance: Paplico | undefined;
};

/**
 * Marks the Paplico instance the dev hot reload re-attaches to the
 * re-evaluated class. A no-op outside development.
 */
export function registerForHotReload(paplico: Paplico): void {
	if (process.env.NODE_ENV !== "development") return;
	hotReloadState().instance = paplico;
}

if (process.env.NODE_ENV === "development" && typeof window !== "undefined") {
	const hmr = hotReloadState();
	hmr.evalCount++;

	console.log(`[HMR] core/ module re-evaluated (count: ${hmr.evalCount})`);

	if (hmr.evalCount > 1) {
		// Debounce: Fast Refresh can trigger multiple module re-evaluations
		// in quick succession. Only fire reload once after they settle.
		clearTimeout(hmr.debounceTimer);
		hmr.debounceTimer = setTimeout(async () => {
			try {
				const p = hmr.instance;
				if (!p) {
					console.warn(
						"[HMR] no Paplico registered with registerForHotReload, skipping reload",
					);
					return;
				}

				Object.setPrototypeOf(p, Paplico.prototype);
				await p._devHotReload();
			} catch (err) {
				console.error("[HMR] Error during hot reload:", err);
			}
		}, 150);
	}
}

/**
 * The state lives on window because this module is re-evaluated on every hot
 * update, and a module-level variable would start over each time.
 */
function hotReloadState(): HotReloadState {
	const w = window as unknown as { __paplico_hmr?: HotReloadState };
	w.__paplico_hmr ??= {
		evalCount: 0,
		debounceTimer: undefined,
		instance: undefined,
	};
	return w.__paplico_hmr;
}
