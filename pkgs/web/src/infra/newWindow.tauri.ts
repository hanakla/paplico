/** Opens another window of the desktop app with an empty session. */
export async function tauriOpenNewWindow(): Promise<void> {
	const { invoke } = await import("@tauri-apps/api/core");
	await invoke("open_new_window");
}
