"use client";

import { memo } from "react";
import { Dialog } from "@/components/Dialog";
import { Spinner } from "@/components/Spinner";

export const SpinnerDialog = memo(function SpinnerDialog({
	open,
	message,
}: {
	open: boolean;
	message?: string;
}) {
	return (
		<Dialog.Root open={open}>
			<Dialog.Content className="w-40 aspect-square p-6 flex flex-col items-center justify-center gap-3 border-none">
				<Spinner $size="lg" />
				{message && <p className="text-sm text-foreground">{message}</p>}
			</Dialog.Content>
		</Dialog.Root>
	);
});
