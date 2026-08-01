import {
	notificationState,
	resolveBanner,
	showBanner,
	showFatal,
} from "../notificationStore";

describe("notificationStore", () => {
	beforeEach(() => {
		notificationState.banners = [];
		notificationState.fatal = null;
	});

	describe("showBanner", () => {
		it("should keep a single banner when called repeatedly with the same key", () => {
			showBanner({
				key: "AUTOSAVE_FAILED",
				titleKey: "errors.autosaveFailed",
			});
			showBanner({
				key: "AUTOSAVE_FAILED",
				titleKey: "errors.autosaveFailed",
				descriptionKey: "errors.autosaveFailedDescription",
			});

			expect(notificationState.banners).toHaveLength(1);
			expect(notificationState.banners[0].descriptionKey).toBe(
				"errors.autosaveFailedDescription",
			);
		});
	});

	describe("resolveBanner", () => {
		it("should remove the banner with the given key", () => {
			showBanner({
				key: "AUTOSAVE_FAILED",
				titleKey: "errors.autosaveFailed",
			});

			resolveBanner("AUTOSAVE_FAILED");

			expect(notificationState.banners).toHaveLength(0);
		});

		it("should do nothing when resolving a key that does not exist", () => {
			showBanner({
				key: "AUTOSAVE_FAILED",
				titleKey: "errors.autosaveFailed",
			});

			resolveBanner("EXPORT_FAILED");

			expect(notificationState.banners).toHaveLength(1);
			expect(notificationState.banners[0].key).toBe("AUTOSAVE_FAILED");
		});
	});

	describe("showFatal", () => {
		it("should keep the first fatal error and ignore subsequent ones", () => {
			showFatal({
				code: "WEBGPU_UNSUPPORTED",
				titleKey: "errors.webgpuUnsupported",
			});
			showFatal({
				code: "WEBGPU_INIT_FAILED",
				titleKey: "errors.webgpuInitFailed",
			});

			expect(notificationState.fatal?.code).toBe("WEBGPU_UNSUPPORTED");
			expect(notificationState.fatal?.titleKey).toBe(
				"errors.webgpuUnsupported",
			);
		});
	});
});
