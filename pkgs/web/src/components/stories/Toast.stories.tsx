import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { Toast, toastManager } from "../Toast";

function ToastDemo() {
	return (
		<Toast.Provider>
			<div className="flex flex-wrap gap-2">
				<button
					type="button"
					className="rounded px-3 py-1.5 text-sm bg-muted hover:bg-muted-hover"
					onClick={() =>
						toastManager.add({
							title: "Default toast",
							description: "This is a default notification.",
						})
					}
				>
					Default
				</button>
				<button
					type="button"
					className="rounded px-3 py-1.5 text-sm bg-warn/20 hover:bg-warn/30 text-warn-foreground"
					onClick={() =>
						toastManager.add({
							title: "Warning toast",
							description: "Something needs attention.",
							type: "warning",
						})
					}
				>
					Warning
				</button>
				<button
					type="button"
					className="rounded px-3 py-1.5 text-sm bg-accent/20 hover:bg-accent/30 text-accent-foreground"
					onClick={() =>
						toastManager.add({
							title: "Info toast",
							description: "Connection restored.",
							type: "info",
						})
					}
				>
					Info
				</button>
			</div>
			<Toast.Portal>
				<Toast.Viewport>
					<ToastList />
				</Toast.Viewport>
			</Toast.Portal>
		</Toast.Provider>
	);
}

function ToastList() {
	const { toasts } = Toast.useToastManager();
	return toasts.map((toast) => (
		<Toast.Root key={toast.id} toast={toast}>
			<Toast.Content>
				<Toast.Title />
				<Toast.Description />
			</Toast.Content>
			<Toast.Close />
		</Toast.Root>
	));
}

const meta = {
	title: "Components/Toast",
	component: ToastDemo,
} satisfies Meta<typeof ToastDemo>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Playground: Story = {};
