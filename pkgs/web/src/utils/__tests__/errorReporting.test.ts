import * as Sentry from "@sentry/nextjs";
import { toastManager } from "@/components/Toast";
import { PaplicoError } from "@/core";
import { setLanguage } from "@/hooks/useAppConfig";
import { notificationState } from "@/stores/notificationStore";
import { codeFromError, reportError } from "../errorReporting";

vi.mock("@sentry/nextjs", () => ({
	captureException: vi.fn(),
}));

// errorReporting keeps module-level dedup timestamps across tests.
// Each test starts on a fresh fake system time far past every dedup window
// (toast 5s / Sentry 60s), so state from previous tests never interferes.
let testStartTime = Date.UTC(2026, 0, 1);

describe("reportError", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		testStartTime += 3_600_000;
		vi.setSystemTime(testStartTime);

		vi.spyOn(toastManager, "add").mockReturnValue("toast-id");
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.mocked(Sentry.captureException).mockClear();

		setLanguage("en");
		notificationState.banners = [];
		notificationState.fatal = null;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it("should show a localized error toast when an error is reported", () => {
		reportError({ code: "EXPORT_FAILED" });

		const addMock = vi.mocked(toastManager.add);
		expect(addMock).toHaveBeenCalledTimes(1);

		const options = addMock.mock.calls[0][0];
		expect(options.title).toBe("Failed to export");
		expect(options.type).toBe("error");
	});

	it("should show only one toast for the same code within 5 seconds, then show again after", () => {
		reportError({ code: "EXPORT_FAILED" });
		reportError({ code: "EXPORT_FAILED" });

		const addMock = vi.mocked(toastManager.add);
		expect(addMock).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(5_000);
		reportError({ code: "EXPORT_FAILED" });

		expect(addMock).toHaveBeenCalledTimes(2);
	});

	it("should not send to Sentry when capture is false", () => {
		reportError({ code: "ROOM_CREATE_FAILED", capture: false });

		expect(vi.mocked(Sentry.captureException)).not.toHaveBeenCalled();
	});

	it("should send the same code to Sentry at most once per 60 seconds", () => {
		reportError({ code: "IMPORT_FAILED", cause: new Error("first") });
		reportError({ code: "IMPORT_FAILED", cause: new Error("second") });

		const captureMock = vi.mocked(Sentry.captureException);
		expect(captureMock).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(60_000);
		reportError({ code: "IMPORT_FAILED", cause: new Error("third") });

		expect(captureMock).toHaveBeenCalledTimes(2);
	});

	it("should route banner channel reports into notificationState.banners", () => {
		reportError({ code: "AUTOSAVE_FAILED", channel: "banner" });

		expect(notificationState.banners).toHaveLength(1);
		expect(notificationState.banners[0].key).toBe("AUTOSAVE_FAILED");
		expect(vi.mocked(toastManager.add)).not.toHaveBeenCalled();
	});

	it("should route fatal channel reports into notificationState.fatal", () => {
		reportError({ code: "WEBGPU_UNSUPPORTED", channel: "fatal" });

		expect(notificationState.fatal?.code).toBe("WEBGPU_UNSUPPORTED");
		expect(vi.mocked(toastManager.add)).not.toHaveBeenCalled();
	});
});

describe("codeFromError", () => {
	it("should resolve a PaplicoError to its own code", () => {
		const error = new PaplicoError("PAPF_CORRUPTED", "corrupted document");

		expect(codeFromError(error, "IMPORT_FAILED")).toBe("PAPF_CORRUPTED");
	});

	it("should fall back to the given code for a plain Error", () => {
		expect(codeFromError(new Error("boom"), "IMPORT_FAILED")).toBe(
			"IMPORT_FAILED",
		);
	});
});
