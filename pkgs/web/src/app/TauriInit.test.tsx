import { PhysicalPosition } from "@tauri-apps/api/dpi";
import type { DragDropEvent } from "@tauri-apps/api/webview";
import { render, waitFor } from "@testing-library/react";
import { TauriInit } from "./TauriInit";

const { onDragDropEvent } = vi.hoisted(() => ({
	onDragDropEvent: vi.fn(),
}));

vi.mock("@/utils/platform", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/utils/platform")>()),
	IS_TAURI_ENV: true,
}));
vi.mock("@/auth/tauriAuth", () => ({ handleAuthDeepLink: vi.fn() }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
	getCurrentWebviewWindow: () => ({ onDragDropEvent }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => [] }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => vi.fn() }));
vi.mock("@tauri-apps/plugin-deep-link", () => ({
	onOpenUrl: async () => vi.fn(),
}));

describe("Tauri file drops", () => {
	beforeEach(() => {
		vi.spyOn(navigator, "userAgent", "get").mockReturnValue("PaplicoDesktop");
		vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
		onDragDropEvent.mockReset();
		onDragDropEvent.mockResolvedValue(vi.fn());
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it.each([
		1, 2,
	])("places a file at the pointer on a macOS display with scale %s", async (scale) => {
		vi.stubGlobal("devicePixelRatio", scale);
		const dropped = vi.fn();
		window.addEventListener("tauri-file-drop", dropped);
		const view = render(<TauriInit />);

		try {
			await waitFor(() => expect(onDragDropEvent).toHaveBeenCalledOnce());
			const handleDrop = onDragDropEvent.mock.calls[0][0] as (event: {
				payload: DragDropEvent;
			}) => void;
			handleDrop({
				payload: {
					type: "drop",
					paths: ["/drawings/reference.png"],
					position: new PhysicalPosition(120 * scale, 80 * scale),
				},
			});

			expect(dropped).toHaveBeenCalledOnce();
			expect(dropped.mock.calls[0][0].detail).toEqual({
				paths: ["/drawings/reference.png"],
				position: { x: 120, y: 80 },
			});
		} finally {
			view.unmount();
			window.removeEventListener("tauri-file-drop", dropped);
		}
	});
});
