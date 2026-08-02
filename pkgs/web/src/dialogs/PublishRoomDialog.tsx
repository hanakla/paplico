import {
	Check,
	Copy,
	QrCode,
	ScanLine,
	Share2,
	X as XIcon,
} from "lucide-react";
import { useState } from "react";
import { createCallable } from "react-call";
import { OAUTH_PROVIDERS, type OAuthStrategy } from "@/auth/oauthProviders";
import { Button } from "@/components/Button";
import { Dialog } from "@/components/Dialog";
import { SessionQrCode } from "@/components/SessionQrCode";
import { useUserSession } from "@/hooks/useUserSession";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";
import { twm } from "@/utils/tailwind";

const isCloudMode = process.env.NEXT_PUBLIC_COLLAB_MODE === "cloud";

export const PublishRoomDialog = createCallable<
	{
		/**
		 * Encrypted rooms hand out no usable room id — the key lives in the invite
		 * URL fragment, so the link and its QR code are the only thing worth
		 * sharing, and no account is needed to host one.
		 */
		encrypted: boolean;
		publishedRoomId: string | null;
		inviteUrl: string | null;
		/**
		 * What the QR carries for an encrypted session. A URL would name the
		 * address it was generated on, which the scanning device often cannot
		 * reach; the room and key are the only parts that travel meaningfully.
		 */
		inviteCode: string | null;
		onPublish: (readonly: boolean) => Promise<{
			roomId: string;
			inviteUrl: string;
			inviteCode: string | null;
		} | null>;
		/**
		 * Opens the camera to scan a code shown on another device. Only offered
		 * for encrypted (device-to-device) sessions.
		 */
		onScanCode?: () => void;
	},
	void
>(
	({
		call,
		encrypted,
		publishedRoomId: initialRoomId,
		inviteUrl: initialInviteUrl,
		inviteCode: initialInviteCode,
		onPublish,
		onScanCode,
	}) => {
		const { isSignedIn, authenticate } = useUserSession();
		const needsPublishSignIn = isCloudMode && !encrypted && !isSignedIn;
		const t = useTranslation();
		const [roomId, setRoomId] = useState(initialRoomId);
		const [inviteUrl, setInviteUrl] = useState(initialInviteUrl);
		const [inviteCode, setInviteCode] = useState(initialInviteCode);
		const [readonly, setReadonly] = useState(false);
		const [copiedField, setCopiedField] = useState<string | null>(null);

		const handleCopyToClipboard = useEventCallback(
			(text: string, field: string) => {
				navigator.clipboard.writeText(text);
				setCopiedField(field);
				setTimeout(() => setCopiedField(null), 2000);
			},
		);

		const handleCopyRoomId = useEventCallback(() => {
			handleCopyToClipboard(roomId ?? "", "roomId");
		});

		const handleCopyRoomUrl = useEventCallback(() => {
			handleCopyToClipboard(inviteUrl ?? "", "roomUrl");
		});

		const handleOAuthSignIn = useEventCallback(
			(e: React.MouseEvent<HTMLButtonElement>) => {
				const strategy = e.currentTarget.dataset.strategy as OAuthStrategy;
				authenticate(strategy);
			},
		);

		const handlePublish = useEventCallback(async () => {
			const published = await onPublish(readonly);
			if (!published) return;

			setRoomId(published.roomId);
			setInviteUrl(published.inviteUrl);
			setInviteCode(published.inviteCode);
		});

		const handleClose = useEventCallback(() => {
			call.end();
		});

		const handleScanCode = useEventCallback(() => {
			call.end();
			onScanCode?.();
		});

		const handleOpenChange = useEventCallback((open: boolean) => {
			if (!open) call.end();
		});

		return (
			<Dialog.Root open onOpenChange={handleOpenChange}>
				<Dialog.Content className="w-90 p-0 flex flex-col">
					<div className="flex items-center justify-between px-4 py-3 border-b border-border/30">
						<Dialog.Title className="text-sm font-medium mb-0">
							{encrypted
								? t("connectRoomDialog.connectOtherDevices")
								: t("connectRoomDialog.publishRoom")}
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
						{needsPublishSignIn && !roomId && (
							<div className="flex flex-col gap-2">
								<span className="text-xs text-muted-foreground">
									{t("auth.signInRequired")}
								</span>
								{OAUTH_PROVIDERS.map((provider) => (
									<Button
										key={provider.strategy}
										$variant="secondary"
										$size="sm"
										className="w-full justify-center gap-3 h-10"
										data-strategy={provider.strategy}
										onClick={handleOAuthSignIn}
									>
										{provider.icon}
										<span className="text-sm">
											{t("auth.continueWith", { provider: provider.label })}
										</span>
									</Button>
								))}
							</div>
						)}
						{roomId ? (
							<>
								<div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-accent/10 border border-accent/30 text-sm">
									<Check size={14} className="text-accent shrink-0" />
									<span className="text-accent">
										{encrypted
											? t("connectRoomDialog.deviceCodeReady")
											: t("connectRoomDialog.roomPublished")}
									</span>
								</div>

								<p className="text-xs text-muted-foreground">
									{encrypted
										? t("connectRoomDialog.connectOtherDevicesDescription")
										: t("connectRoomDialog.shareRoomDescription")}
								</p>

								{encrypted && inviteCode && (
									<div className="flex justify-center">
										<SessionQrCode
											value={inviteCode}
											title={t("connectRoomDialog.inviteQrLabel")}
										/>
									</div>
								)}

								<div className="space-y-2">
									{!encrypted && (
										<div className="flex items-center gap-2">
											<code className="flex-1 text-xs bg-muted/50 px-3 py-2 rounded truncate">
												{roomId}
											</code>
											<button
												type="button"
												onClick={handleCopyRoomId}
												className="p-2 rounded hover:bg-foreground/10 transition-colors shrink-0"
											>
												{copiedField === "roomId" ? (
													<Check size={14} className="text-accent" />
												) : (
													<Copy size={14} />
												)}
											</button>
										</div>
									)}
									<div className="flex items-center gap-2">
										<code className="flex-1 text-xs bg-muted/50 px-3 py-2 rounded truncate">
											{inviteUrl}
										</code>
										<button
											type="button"
											onClick={handleCopyRoomUrl}
											className="p-2 rounded hover:bg-foreground/10 transition-colors shrink-0"
										>
											{copiedField === "roomUrl" ? (
												<Check size={14} className="text-accent" />
											) : (
												<Copy size={14} />
											)}
										</button>
									</div>
								</div>

								{encrypted && (
									<p className="text-xs text-muted-foreground">
										{t("connectRoomDialog.inviteShareCaution")}
									</p>
								)}
							</>
						) : encrypted ? (
							// Read-only makes no sense when the point is to reach your own
							// other device, so this path only explains what will happen.
							<p className="text-xs text-muted-foreground">
								{t("connectRoomDialog.connectOtherDevicesIntro")}
							</p>
						) : (
							<>
								<p className="text-xs text-muted-foreground">
									{t("connectRoomDialog.publishRoomIntro")}
								</p>

								{/* Read-only publishing is kept out of the dialog rather than
								    deleted: there is no sign yet that anyone wants it, so
								    whether it is worth carrying is unknown. The flag it set
								    still travels through onPublish, so restoring this only
								    means uncommenting.

								<label className="flex items-center gap-3 cursor-pointer">
									<Checkbox checked={readonly} onCheckedChange={setReadonly} />
									<div>
										<span className="text-sm block">
											{t("connectRoomDialog.readOnly")}
										</span>
										<span className="text-xs text-muted-foreground">
											{t("connectRoomDialog.readOnlyDescription")}
										</span>
									</div>
								</label>
								*/}
							</>
						)}
					</div>

					<div
						className={twm(
							"flex justify-end gap-2 px-4 py-3 border-t border-border/30",
							!roomId && encrypted && "flex-col",
						)}
					>
						{roomId ? (
							<Button $variant="default" $size="sm" onClick={handleClose}>
								{t("connectRoomDialog.backToCanvas")}
							</Button>
						) : (
							<>
								<Button
									$variant="ghost"
									$size="sm"
									className={twm(encrypted && "justify-center order-last")}
									onClick={handleClose}
								>
									{t("connectRoomDialog.cancel")}
								</Button>
								{encrypted && onScanCode && (
									<Button
										$variant="secondary"
										$size="sm"
										className="justify-center"
										onClick={handleScanCode}
									>
										<ScanLine size={14} />
										{t("connectRoomDialog.scanCode")}
									</Button>
								)}
								<Button
									$variant="default"
									$size="sm"
									className={twm(encrypted && "justify-center")}
									onClick={handlePublish}
									disabled={needsPublishSignIn}
								>
									{encrypted ? <QrCode size={14} /> : <Share2 size={14} />}
									{encrypted
										? t("connectRoomDialog.showCode")
										: t("connectRoomDialog.publish")}
								</Button>
							</>
						)}
					</div>
				</Dialog.Content>
			</Dialog.Root>
		);
	},
);
