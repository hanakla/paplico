import { Paplico } from "./Paplico";

if (process.env.NODE_ENV === "development" && typeof window !== "undefined") {
	const w = window as any;
	if (!w.__paplico_hmr) {
		w.__paplico_hmr = { evalCount: 0, debounceTimer: null };
	}
	const hmr = w.__paplico_hmr;
	hmr.evalCount++;

	console.log(`[HMR] core/ module re-evaluated (count: ${hmr.evalCount})`);

	if (hmr.evalCount > 1) {
		// Debounce: Fast Refresh can trigger multiple module re-evaluations
		// in quick succession. Only fire reload once after they settle.
		clearTimeout(hmr.debounceTimer);
		hmr.debounceTimer = setTimeout(async () => {
			try {
				const p = w.__paplico as Paplico | undefined;
				if (!p) {
					console.warn("[HMR] window.__paplico not found, skipping reload");
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
