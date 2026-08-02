import { Check, Copy, Gamepad2, ScanLine, X as XIcon } from "lucide-react";
import { useState } from "react";
import { createCallable } from "react-call";
import { useSnapshot } from "valtio";
import { Button } from "@/components/Button";
import { Dialog } from "@/components/Dialog";
import { SessionQrCode } from "@/components/SessionQrCode";
import { scanCompanionCode } from "@/dialogs/scanCompanionCode";
import { useTranslation } from "@/locales";
import {
	companionHostState,
	startCompanionSession,
	stopCompanionSession,
} from "@/organisms/CompanionHost";
import { openCompanionRemote } from "@/organisms/CompanionRemoteModal";
import { useEventCallback } from "@/utils/hooks";

/**
 * Hands out the code that turns another device into a remote for this one.
 *
 * The session is not owned here: closing the dialog leaves it running, which
 * is the point — the code is shown once and the canvas is what you go back to.
 */
export const CompanionDialog = createCallable<Record<never, never>, void>(
	({ call }) => {
		const t = useTranslation();
		const hostSnap = useSnapshot(companionHostState);
		const [copied, setCopied] = useState(false);
		const [scanFailed, setScanFailed] = useState(false);

		const handleStart = useEventCallback(() => {
			startCompanionSession();
		});

		/** The other direction: read a code and become the remote ourselves. */
		const handleScan = useEventCallback(async () => {
			const result = await scanCompanionCode();
			if (result.status === "cancelled") return;
			if (result.status === "unusable") {
				setScanFailed(true);
				return;
			}

			openCompanionRemote(result.credentials);
			call.end();
		});

		const handleStop = useEventCallback(() => {
			stopCompanionSession();
			call.end();
		});

		const handleCopy = useEventCallback(() => {
			if (!hostSnap.adhocUrl) return;
			navigator.clipboard.writeText(hostSnap.adhocUrl);
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		});

		const handleClose = useEventCallback(() => {
			call.end();
		});

		const handleOpenChange = useEventCallback((open: boolean) => {
			if (!open) call.end();
		});

		return (
			<Dialog.Root open onOpenChange={handleOpenChange}>
				<Dialog.Content className="w-90 p-0 flex flex-col">
					<div className="flex items-center justify-between px-4 py-3 border-b border-border/30">
						<Dialog.Title className="text-sm font-medium mb-0">
							{t("companion.title")}
						</Dialog.Title>
						<Dialog.Close>
							<button
								type="button"
								className="p-1 rounded hover:bg-foreground/10 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
							>
								<XIcon size={16} />
							</button>
						</Dialog.Close>
					</div>

					<div className="p-4 space-y-4">
						{hostSnap.adhocUrl ? (
							<>
								<div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-accent/10 border border-accent/30 text-sm">
									<Check size={14} className="text-accent shrink-0" />
									<span className="text-accent">
										{hostSnap.companionPresent
											? t("companion.connected")
											: t("companion.codeReady")}
									</span>
								</div>

								<p className="text-xs text-muted-foreground">
									{t("companion.codeDescription")}
								</p>

								<div className="flex justify-center">
									<SessionQrCode
										value={hostSnap.adhocUrl}
										title={t("connectRoomDialog.inviteQrLabel")}
									/>
								</div>

								<div className="flex items-center gap-2">
									<code className="flex-1 text-xs bg-muted/50 px-3 py-2 rounded truncate">
										{hostSnap.adhocUrl}
									</code>
									<button
										type="button"
										onClick={handleCopy}
										className="p-2 rounded hover:bg-foreground/10 transition-colors shrink-0"
									>
										{copied ? (
											<Check size={14} className="text-accent" />
										) : (
											<Copy size={14} />
										)}
									</button>
								</div>

								<p className="text-xs text-muted-foreground">
									{t("companion.codeShareCaution")}
								</p>
							</>
						) : (
							<p className="text-xs text-muted-foreground">
								{scanFailed
									? t("companion.notInviteCode")
									: t("companion.intro")}
							</p>
						)}
					</div>

					{/* Stacked, because the two directions are a choice to read rather
					    than a row to skim, and neither reads as the obvious one. */}
					<div className="flex flex-col gap-2 px-4 py-3 border-t border-border/30">
						{hostSnap.adhocUrl ? (
							<>
								<Button
									$variant="default"
									$size="sm"
									className="justify-center"
									onClick={handleClose}
								>
									{t("connectRoomDialog.backToCanvas")}
								</Button>
								<Button
									$variant="ghost"
									$size="sm"
									className="justify-center"
									onClick={handleStop}
								>
									{t("companion.endSession")}
								</Button>
							</>
						) : (
							<>
								<Button
									$variant="default"
									$size="sm"
									className="justify-center"
									onClick={handleStart}
								>
									<Gamepad2 size={14} />
									{t("companion.showCode")}
								</Button>
								<Button
									$variant="secondary"
									$size="sm"
									className="justify-center"
									onClick={handleScan}
								>
									<ScanLine size={14} />
									{t("companion.scanCode")}
								</Button>
								<Button
									$variant="ghost"
									$size="sm"
									className="justify-center"
									onClick={handleClose}
								>
									{t("connectRoomDialog.cancel")}
								</Button>
							</>
						)}
					</div>
				</Dialog.Content>
			</Dialog.Root>
		);
	},
);
