"use client";

import { Gamepad2, ScanLine } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/Button";
import { parseInvite } from "@/core/collaboration/inviteUrl";
import { importRoomKey } from "@/core/collaboration/roomCrypto";
import { ScanInviteDialog } from "@/dialogs/ScanInviteDialog";
import { scanCompanionCode } from "@/dialogs/scanCompanionCode";
import {
	appConfig,
	applyThemeToDOM,
	initAppConfig,
} from "@/hooks/useAppConfig";
import {
	type CompanionCredentials,
	useCompanionClient,
} from "@/hooks/useCompanionClient";
import { useTranslation } from "@/locales";
import { CompanionPanel } from "@/organisms/CompanionPanel";
import { useEventCallback } from "@/utils/hooks";

/**
 * The remote control as a page of its own, for a device that is not running
 * Paplico — a phone you pick up beside the machine you are drawing on.
 *
 * The room and key arrive either in the address — the key sits in the fragment,
 * which no server ever sees — or by reading a code off the other device's
 * screen. Either way they go no further than this browser.
 */
export function CompanionApp() {
	const t = useTranslation();
	const [credentials, setCredentials] = useState<CompanionCredentials | null>(
		null,
	);
	const [scanFailed, setScanFailed] = useState(false);

	const connect = useEventCallback(
		async (roomId: string, encodedKey: string): Promise<boolean> => {
			try {
				setCredentials({ roomId, roomKey: await importRoomKey(encodedKey) });
				return true;
			} catch {
				return false;
			}
		},
	);

	// The page never went through the app's startup, so the stored language and
	// theme were never applied and every label fell back to English.
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs once on mount
	useEffect(() => {
		void initAppConfig().then(() => applyThemeToDOM(appConfig.theme));
	}, []);

	// Read from location rather than useSearchParams: the key is in the fragment,
	// so there is nothing a server could have rendered ahead of time. Arriving
	// without one is the ordinary way in, and asks to scan instead.
	// biome-ignore lint/correctness/useExhaustiveDependencies: useEventCallback keeps a stable reference
	useEffect(() => {
		const invite = parseInvite(window.location.href);
		if (invite?.encodedKey) void connect(invite.roomId, invite.encodedKey);
	}, []);

	const handleScan = useEventCallback(async () => {
		const result = await scanCompanionCode();
		if (result.status === "cancelled") return;

		setScanFailed(result.status === "unusable");
		if (result.status === "ok") setCredentials(result.credentials);
	});

	return (
		<div className="h-dvh flex flex-col bg-background text-foreground">
			{credentials ? (
				<ConnectedCompanion credentials={credentials} />
			) : (
				<div className="flex flex-col items-center justify-center gap-4 flex-1 px-8 pt-safe-top pb-safe-bottom text-center">
					<Gamepad2 size={40} className="text-muted-foreground" />
					<p className="text-sm">
						{scanFailed
							? t("companion.notInviteCode")
							: t("companion.notConnectedGuide")}
					</p>
					<Button
						$variant="default"
						$size="md"
						className="min-h-11 justify-center"
						onClick={handleScan}
					>
						<ScanLine size={16} />
						{t("companion.scanCode")}
					</Button>
				</div>
			)}

			<ScanInviteDialog.Root />
		</div>
	);
}

function ConnectedCompanion({
	credentials,
}: {
	credentials: CompanionCredentials;
}) {
	const { state, status, sendCommand } = useCompanionClient(credentials);

	return (
		<CompanionPanel
			state={state}
			status={status}
			onCommand={sendCommand}
			withSafeAreaInsets
		/>
	);
}
