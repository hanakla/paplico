/**
 * Show a title on the desktop app's window. The desktop webview does not pass
 * `document.title` on to its window.
 */
export async function tauriSetWindowTitle(title: string): Promise<void> {
	const { getCurrentWindow } = await import("@tauri-apps/api/window");
	await getCurrentWindow().setTitle(title);
}
