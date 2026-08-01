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
			<Dialog.Content className="w-[240px] p-6 flex flex-col items-center gap-3">
				<Spinner $size="lg" />
				{message && <p className="text-sm text-muted-foreground">{message}</p>}
			</Dialog.Content>
		</Dialog.Root>
	);
});
