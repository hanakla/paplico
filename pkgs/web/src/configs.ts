// --- Auto-save timing ---

/** Default auto-save interval (ms) */
export const AUTO_SAVE_INTERVAL_MS = 60_000;

/** Extended interval for large documents (ms) */
export const AUTO_SAVE_SLOW_INTERVAL_MS = 300_000;

/** Threshold to detect slow saves and extend interval (ms) */
export const AUTO_SAVE_SLOW_THRESHOLD_MS = 1_000;

/** Max revisions kept per document */
export const AUTO_SAVE_MAX_REVISIONS = 20;

// --- Collaboration ---

/** PartyKit host (`host:port`) serving cloud rooms and the E2EE relay. */
export const PARTYKIT_HOST =
	process.env.NEXT_PUBLIC_PARTYKIT_HOST ?? "localhost:1999";

/**
 * Origin of the web app: where its API is served and where shared links
 * should point. The desktop build runs off tauri://localhost, an origin that
 * exists only inside that app — neither a request nor a link built from it
 * reaches anything. The deployed site is the address both the desktop build
 * and a guest can reach, and the desktop build is given it at build time.
 */
export function webOrigin(): string {
	return process.env.NEXT_PUBLIC_API_BASE_URL || window.location.origin;
}

// --- Rasterization resolution ---

export { BASE_DPI } from "@paplico/core/document";

/** DPI presets offered by the document filter-resolution and export selectors. */
export const RASTERIZATION_DPI_PRESETS: readonly number[] = [72, 144, 300];
