/**
 * SignInDialog - Custom OAuth sign-in dialog for cloud mode
 *
 * Displays OAuth provider buttons (X, Discord).
 * Only rendered in cloud mode (NEXT_PUBLIC_COLLAB_MODE=cloud).
 *
 * After successful sign-in (OAuth popup round-trip),
 * the onSignInComplete callback fires when isSignedIn becomes true.
 */

import { X } from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { OAUTH_PROVIDERS, type OAuthStrategy } from "@/auth/oauthProviders";
import { Button } from "@/components/Button";
import { Dialog } from "@/components/Dialog";
import { useUserSession } from "@/hooks/useUserSession";
import { useTranslation } from "@/locales";
import { twm } from "@/utils/tailwind";

export const SignInDialog = memo(function SignInDialog({
	open,
	onOpenChange,
	onSignInComplete,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onSignInComplete?: () => void;
}) {
	const { isSignedIn, authenticate } = useUserSession();
	const wasOpenRef = useRef(false);
	const [loading, setLoading] = useState<string | null>(null);
	const t = useTranslation();

	// Detect sign-in completion: dialog was open + user became signed in
	useEffect(() => {
		if (open) {
			wasOpenRef.current = true;
		}

		if (wasOpenRef.current && isSignedIn) {
			wasOpenRef.current = false;
			onSignInComplete?.();
		}
	}, [open, isSignedIn, onSignInComplete]);

	const handleOAuth = useCallback(
		async (strategy: OAuthStrategy) => {
			setLoading(strategy);
			try {
				await authenticate(strategy);
			} catch (err) {
				console.error("OAuth sign-in failed:", err);
			} finally {
				setLoading(null);
			}
		},
		[authenticate],
	);

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Content className="w-[320px] p-0 flex flex-col">
				{/* Header */}
				<div className="flex items-center justify-between px-4 py-3 border-b border-border/30">
					<Dialog.Title className="text-sm font-medium mb-0">
						{t("auth.signInRequired")}
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

				{/* OAuth buttons */}
				<div className="p-4 flex flex-col gap-2">
					{OAUTH_PROVIDERS.map((provider) => (
						<Button
							key={provider.strategy}
							$variant="secondary"
							$size="sm"
							className="w-full justify-center gap-3 h-10"
							onClick={() => handleOAuth(provider.strategy)}
							disabled={loading !== null}
						>
							{provider.icon}
							<span className="text-sm">
								{loading === provider.strategy
									? "..."
									: t("auth.continueWith", { provider: provider.label })}
							</span>
						</Button>
					))}
				</div>
			</Dialog.Content>
		</Dialog.Root>
	);
});
