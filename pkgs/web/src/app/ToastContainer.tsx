"use client";
import type { ReactNode } from "react";
import { Toast } from "@/components/Toast";

export function ToastContainer({ children }: { children: ReactNode }) {
	return (
		<Toast.Provider>
			{children}
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
				{toast.actionProps && <Toast.Action {...toast.actionProps} />}
				<Toast.Close />
			</Toast.Content>
		</Toast.Root>
	));
}
