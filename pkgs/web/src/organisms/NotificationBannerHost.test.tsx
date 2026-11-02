import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { setLanguage } from "@/hooks/useAppConfig";
import { NotificationBannerHost } from "@/organisms/NotificationBannerHost";
import {
	notificationState,
	resolveBanner,
	showBanner,
} from "@/stores/notificationStore";

describe("NotificationBannerHost", () => {
	beforeEach(() => {
		setLanguage("en");
		notificationState.banners = [];
		notificationState.fatal = null;
	});

	it("should display the banner title and call the action handler on click", async () => {
		const onActionClick = vi.fn();
		render(<NotificationBannerHost />);

		await act(async () => {
			showBanner({
				key: "AUTOSAVE_FAILED",
				titleKey: "errors.autosaveFailed",
				descriptionKey: "errors.autosaveFailedDescription",
				action: { labelKey: "errors.retryAction", onClick: onActionClick },
			});
		});

		expect(
			await screen.findByText("Auto-saving to the app is failing"),
		).toBeTruthy();

		fireEvent.click(screen.getByText("Retry"));
		expect(onActionClick).toHaveBeenCalledTimes(1);
	});

	it("should remove the banner after resolveBanner", async () => {
		render(<NotificationBannerHost />);

		await act(async () => {
			showBanner({
				key: "AUTOSAVE_FAILED",
				titleKey: "errors.autosaveFailed",
			});
		});
		await screen.findByText("Auto-saving to the app is failing");

		await act(async () => {
			resolveBanner("AUTOSAVE_FAILED");
		});

		await waitFor(() => {
			expect(
				screen.queryByText("Auto-saving to the app is failing"),
			).toBeNull();
		});
	});
});
