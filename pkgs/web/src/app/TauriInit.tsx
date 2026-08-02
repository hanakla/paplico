"use client";

import { useEffect } from "react";
import { handleAuthDeepLink } from "@/auth/tauriAuth";
import type { FileHandle } from "@/infra/filesystem";
import { IS_TAURI_ENV } from "@/utils/platform";

export type TauriFileDropDetail = {
	files: File[];
	handles: FileHandle[];
};

export const TauriInit = IS_TAURI_ENV
	? function TauriInit() {
			useEffect(() => {
				if (!IS_TAURI_ENV) return;

				import("@saurl/tauri-plugin-safe-area-insets-css-api").catch(() => {
					// Plugin's registerListener command is unavailable on desktop
				});
			}, []);

			// Listen for reload events from the native menu (emitted from Rust side)
			useEffect(() => {
				if (!IS_TAURI_ENV) return;

				let cleanup: (() => void) | undefined;

				(async () => {
					const { listen } = await import("@tauri-apps/api/event");
					const unlisten = await listen("app:reload", () => {
						location.reload();
					});
					cleanup = unlisten;
				})();

				return () => cleanup?.();
			}, []);

			useEffect(() => {
				if (!IS_TAURI_ENV) return;

				let cleanup: (() => void) | undefined;

				(async () => {
					const { getCurrentWebviewWindow } = await import(
						"@tauri-apps/api/webviewWindow"
					);
					const { readFile } = await import("@tauri-apps/plugin-fs");

					const unlisten = await getCurrentWebviewWindow().onDragDropEvent(
						async (event) => {
							if (event.payload.type !== "drop") return;

							const paths = event.payload.paths;
							const files: File[] = [];
							const handles: FileHandle[] = [];

							for (const path of paths) {
								const name = path.split("/").pop() ?? path;
								const data = await readFile(path);
								const file = new File([data], name);
								files.push(file);
								handles.push({ handle: path, file } as FileHandle);
							}

							if (files.length > 0) {
								window.dispatchEvent(
									new CustomEvent<TauriFileDropDetail>("tauri-file-drop", {
										detail: { files, handles },
									}),
								);
							}
						},
					);

					cleanup = unlisten;
				})();

				return () => cleanup?.();
				// eslint-disable-next-line react-hooks/exhaustive-deps
			}, []);

			// Deep link listener for OAuth callback (paplico://auth/callback)
			useEffect(() => {
				if (!IS_TAURI_ENV) return;

				let cleanup: (() => void) | undefined;

				(async () => {
					const { onOpenUrl } = await import("@tauri-apps/plugin-deep-link");

					const unlisten = await onOpenUrl((urls) => {
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

					cleanup = unlisten;
				})();

				return () => cleanup?.();
			}, []);

			// Inject Tauri font backend for local font enumeration
			useEffect(() => {
				if (!IS_TAURI_ENV) return;

				(async () => {
					const { TauriLocalFontBackend } = await import(
						"@/core/infra/localfonts.tauri"
					);
					const { getFontManager } = await import(
						"@/core/typography/fonts/FontManager"
					);
					getFontManager().setLocalFontBackend(new TauriLocalFontBackend());
				})();
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
