import { Link, LogOut, Unplug, X } from "lucide-react";
import { memo, useEffect, useState } from "react";
import { OAUTH_PROVIDERS, type OAuthStrategy } from "@/auth/oauthProviders";
import { Button } from "@/components/Button";
import { Dialog } from "@/components/Dialog";
import { Input } from "@/components/Input";
import { Tooltip } from "@/components/Tooltip";
import { parseInvite } from "@/core/collaboration/inviteUrl";
import { useUserSession } from "@/hooks/useUserSession";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";
import { twm } from "@/utils/tailwind";

interface ConnectRoomDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onConnect: (
		roomId: string,
		userName: string,
		encodedRoomKey?: string,
	) => undefined | Promise<{ error?: string } | undefined>;
	onDisconnect: () => void;
	isConnected: boolean;
	currentRoomId: string | null;
	defaultUserName?: string;
	defaultRoomId?: string;
}

export const ConnectRoomDialog = memo(function ConnectRoomDialog({
	open,
	onOpenChange,
	onConnect,
	onDisconnect,
	isConnected,
	currentRoomId,
	defaultUserName = "",
	defaultRoomId = "",
}: ConnectRoomDialogProps) {
	const { isSignedIn, user, authenticate, signOut } = useUserSession();
	const isCloudMode = process.env.NEXT_PUBLIC_COLLAB_MODE === "cloud";
	const [roomId, setRoomId] = useState(defaultRoomId);
	const [userName, setUserName] = useState(defaultUserName);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (defaultRoomId) setRoomId(defaultRoomId);
	}, [defaultRoomId]);
	const t = useTranslation();
	const needsSignIn = isCloudMode && !isSignedIn;

	const handleConnect = useEventCallback(async () => {
		// The field accepts a pasted invite link as readily as a bare room id.
		const invite = parseInvite(roomId);
		if (!invite) return;

		setError(null);
		const result = await onConnect(
			invite.roomId,
			userName.trim(),
			invite.encodedKey,
		);
		if (result?.error) {
			setError(result.error);
			return;
		}
		onOpenChange(false);
		setRoomId("");
	});

	const handleKeyDown = useEventCallback((e: React.KeyboardEvent) => {
		if (e.key === "Enter" && !e.nativeEvent.isComposing) handleConnect();
	});

	const handleRoomIdChange = useEventCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => {
			setRoomId(e.target.value);
		},
	);

	const handleUserNameChange = useEventCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => {
			setUserName(e.target.value);
		},
	);

	const handleOAuthSignIn = useEventCallback(
		(e: React.MouseEvent<HTMLButtonElement>) => {
			const strategy = e.currentTarget.dataset.strategy as OAuthStrategy;
			authenticate(strategy);
		},
	);

	const handleDisconnect = useEventCallback(() => {
		onDisconnect();
	});

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Content className="w-[360px] p-0 flex flex-col">
				{/* Header */}
				<div className="flex items-center justify-between px-4 py-3 border-b border-border/30">
					<Dialog.Title className="text-sm font-medium mb-0">
						{t("connectRoomDialog.connectToRoom")}
					</Dialog.Title>
					<Dialog.Close>
						<button
							type="button"
							className={twm(
								"p-1 rounded hover:bg-foreground/10 transition-colors",
								"outline-none focus-visible:ring-2 focus-visible:ring-primary/50",
							)}
						>
							<X size={16} />
						</button>
					</Dialog.Close>
				</div>

				{/* Content */}
				<div className="p-4 space-y-4">
					{/* OAuth sign-in buttons (shown when not signed in) */}
					{needsSignIn && (
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

					{isConnected && !needsSignIn && (
						<div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-accent/10 border border-accent/30 text-sm">
							<Link size={14} className="text-accent shrink-0" />
							<span className="text-accent truncate">{currentRoomId}</span>
						</div>
					)}

					<div className={twm("space-y-2", needsSignIn && "opacity-80")}>
						<div>
							<label
								htmlFor="connect-room-id"
								className="text-xs text-muted-foreground block mb-1.5"
							>
								{t("connectRoomDialog.roomIdOrInviteLink")}
							</label>
							<Input
								id="connect-room-id"
								$size="sm"
								value={roomId}
								autoFocus
								onChange={handleRoomIdChange}
								onKeyDown={handleKeyDown}
								disabled={needsSignIn}
								placeholder={t(
									"connectRoomDialog.roomIdOrInviteLinkPlaceholder",
								)}
							/>
							{error && <p className="text-xs text-danger mt-1">{error}</p>}
						</div>

						<div>
							<label
								htmlFor="connect-user-name"
								className="text-xs text-muted-foreground block mb-1.5"
							>
								{t("connectRoomDialog.userName")}
							</label>
							<Input
								id="connect-user-name"
								$size="sm"
								value={userName}
								onChange={handleUserNameChange}
								onKeyDown={handleKeyDown}
								disabled={needsSignIn}
								placeholder={t("connectRoomDialog.userNamePlaceholder")}
							/>
						</div>
					</div>
				</div>

				{/* Footer */}
				<div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border/30">
					{isConnected ? (
						<Button
							$variant="destructive"
							$size="sm"
							onClick={handleDisconnect}
							className="mr-auto"
						>
							<Unplug size={14} />
							{t("connectRoomDialog.disconnect")}
						</Button>
					) : isSignedIn && user ? (
						<div className="flex items-center gap-2 mr-auto min-w-0">
							{user.imageUrl ? (
								<img
									src={user.imageUrl}
									alt=""
									className="w-5 h-5 rounded-full shrink-0"
								/>
							) : (
								<div className="w-5 h-5 rounded-full bg-primary/20 flex items-center justify-center text-[10px] font-medium shrink-0">
									{(user.fullName ?? user.username ?? "U")
										.charAt(0)
										.toUpperCase()}
								</div>
							)}
							<span className="text-xs text-muted-foreground truncate">
								{user.fullName ?? user.username}
							</span>
							{isSignedIn && (
								<Tooltip content={t("auth.signOut")}>
									<button
										type="button"
										onClick={signOut}
										className={twm(
											"p-1 rounded shrink-0",
											"text-muted-foreground hover:text-foreground hover:bg-foreground/10",
											"transition-colors",
											"outline-none focus-visible:ring-2 focus-visible:ring-primary/50",
										)}
									>
										<LogOut size={14} />
									</button>
								</Tooltip>
							)}
						</div>
					) : null}
					<Dialog.Close>
						<Button $variant="ghost" $size="sm">
							{t("connectRoomDialog.cancel")}
						</Button>
					</Dialog.Close>
					<Button
						$variant="default"
						$size="sm"
						onClick={handleConnect}
						disabled={!roomId.trim() || needsSignIn}
					>
						<Link size={14} />
						{t("connectRoomDialog.connect")}
					</Button>
				</div>
			</Dialog.Content>
		</Dialog.Root>
	);
});
