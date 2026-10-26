"use client";

import { useEffect } from "react";
import { handleAuthDeepLink } from "@/auth/tauriAuth";
import { detectTauriMobile, IS_TAURI_ENV } from "@/utils/platform";

export type TauriFileDropDetail = {
	paths: string[];
};

export const TauriInit = IS_TAURI_ENV
	? function TauriInit() {
			useEffect(() => {
				if (!IS_TAURI_ENV) return;

				// The plugin subscribes to keyboard events on import, and that
				// subscription command exists only in the mobile builds
				if (!detectTauriMobile()) return;

				import("@saurl/tauri-plugin-safe-area-insets-css-api");
			}, []);

			// Listen for reload events from the native menu (emitted from Rust side)
			useEffect(() => {
				if (!IS_TAURI_ENV) return;

				return subscribeAsync(async () => {
					const { listen } = await import("@tauri-apps/api/event");
					return listen("app:reload", () => {
						location.reload();
					});
				});
			}, []);

			useEffect(() => {
				if (!IS_TAURI_ENV) return;

				return subscribeAsync(async () => {
					const { getCurrentWebviewWindow } = await import(
						"@tauri-apps/api/webviewWindow"
					);

					return getCurrentWebviewWindow().onDragDropEvent((event) => {
						if (event.payload.type !== "drop") return;
						dispatchTauriPaths("tauri-file-drop", event.payload.paths);
					});
				});
			}, []);

			// Documents the OS opened through the .papf file association. The
			// Rust side buffers those that arrived before this listener existed.
			useEffect(() => {
				if (!IS_TAURI_ENV) return;

				return subscribeAsync(async () => {
					const { invoke } = await import("@tauri-apps/api/core");
					const { listen } = await import("@tauri-apps/api/event");

					const unlisten = await listen<string[]>(
						"paplico:open-files",
						(event) => dispatchTauriPaths("tauri-open-files", event.payload),
					);

					dispatchTauriPaths(
						"tauri-open-files",
						await invoke<string[]>("take_launch_files"),
					);
					return unlisten;
				});
			}, []);

			// Deep link listener for OAuth callback (paplico://auth/callback)
			useEffect(() => {
				if (!IS_TAURI_ENV) return;

				return subscribeAsync(async () => {
					const { onOpenUrl } = await import("@tauri-apps/plugin-deep-link");

					return onOpenUrl((urls) => {
						for (const url of urls) {
							// Room invites are handled by the canvas page, which owns the
							// connect dialog; auth callbacks stay here.
							if (url.startsWith("paplico://join")) {
								window.dispatchEvent(
									new CustomEvent("paplico-join-room", { detail: url }),
								);
								continue;
							}

							handleAuthDeepLink(url);
						}
					});
				});
			}, []);

			return (
				<script
					// biome-ignore lint/security/noDangerouslySetInnerHtml: ok
					dangerouslySetInnerHTML={{
						__html: `((n=navigator)=>{document.documentElement.classList.toggle("tauri-mac",n.userAgent.includes("PaplicoDesktop")&&n.platform.startsWith("Mac")) })()`,
					}}
				/>
			);
		}
	: function NoTauriInit() {
			return null;
		};

/**
 * Runs an async subscription for an effect. The returned cleanup removes the
 * listener even when the effect is torn down before the subscription settles.
 */
function subscribeAsync(subscribe: () => Promise<() => void>): () => void {
	const unsubscribe = subscribe();
	return () => {
		void unsubscribe.then((unlisten) => unlisten());
	};
}

/** Hands native paths to the page, which reads only the file it opens. */
function dispatchTauriPaths(
	eventName: "tauri-file-drop" | "tauri-open-files",
	paths: string[],
): void {
	if (paths.length === 0) return;

	window.dispatchEvent(
		new CustomEvent<TauriFileDropDetail>(eventName, { detail: { paths } }),
	);
}
