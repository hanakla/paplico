"use client";

import { memo } from "react";
import { proxy, useSnapshot } from "valtio";
import { Dialog } from "@/components/Dialog";
import {
	type CompanionCredentials,
	useCompanionClient,
} from "@/hooks/useCompanionClient";
import { CompanionPanel } from "@/organisms/CompanionPanel";
import { useEventCallback } from "@/utils/hooks";

const remoteState = proxy({ open: false });

/**
 * Which host this device is remote-controlling. Kept out of the Valtio store
 * because a CryptoKey has no business in a snapshot: it is not data to render,
 * and copying it around only widens where a secret lives.
 */
let remoteCredentials: CompanionCredentials | null = null;

/**
 * Turns this device into a remote for the given host. The credentials come
 * either from the encrypted session it is already in, or from a code it just
 * scanned — the panel behaves the same either way.
 */
export function openCompanionRemote(credentials: CompanionCredentials): void {
	remoteCredentials = credentials;
	remoteState.open = true;
}

function closeCompanionRemote(): void {
	remoteState.open = false;
	remoteCredentials = null;
}

/**
 * The remote control inside the app, for a device that is running Paplico
 * rather than the companion page — a tablet you are also drawing on.
 *
 * A centred modal rather than an edge drawer: while it is up, the remote IS
 * the task, and pinning it to an edge only shrank it while suggesting the
 * canvas behind was still the point. Closing costs nothing and leaves nothing
 * behind, which is what makes reaching for it mid-drawing worth doing.
 */
export const CompanionRemoteModal = memo(function CompanionRemoteModal() {
	const snap = useSnapshot(remoteState);

	if (!snap.open || !remoteCredentials) return null;

	return <CompanionRemoteModalContent credentials={remoteCredentials} />;
});

const CompanionRemoteModalContent = memo(function CompanionRemoteModalContent({
	credentials,
}: {
	credentials: CompanionCredentials;
}) {
	const { state, status, sendCommand } = useCompanionClient(credentials);

	const handleOpenChange = useEventCallback((open: boolean) => {
		if (!open) closeCompanionRemote();
	});

	const handleClose = useEventCallback(() => {
		closeCompanionRemote();
	});

	return (
		<Dialog.Root open onOpenChange={handleOpenChange}>
			{/* Tracks the window rather than naming a size: the panel inside decides
			    its own tab layout from the width it actually gets. */}
			<Dialog.Content className="w-[min(92vw,56rem)] h-[min(88dvh,48rem)] p-0 flex flex-col overflow-hidden">
				<CompanionPanel
					state={state}
					status={status}
					onCommand={sendCommand}
					onClose={handleClose}
				/>
			</Dialog.Content>
		</Dialog.Root>
	);
});
