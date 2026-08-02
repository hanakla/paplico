"use client";

import { Menu } from "@base-ui/react/menu";
import { LogOut } from "lucide-react";
import { memo } from "react";
import { useUserSession } from "@/hooks/useUserSession";
import { useTranslation } from "@/locales";
import { twm } from "@/utils/tailwind";

export const UserMenu = memo(function UserMenu({
	roomRole,
}: {
	roomRole?: "owner" | "member";
}) {
	const { isSignedIn, user, signOut } = useUserSession();
	const t = useTranslation();

	if (!isSignedIn || !user) return null;

	return (
		<div className="flex items-center gap-2 shrink-0">
			<Menu.Root>
				<Menu.Trigger
					className={twm(
						"w-7 h-7 rounded-full overflow-hidden",
						"border-2 border-transparent hover:border-primary/50",
						"transition-colors cursor-pointer",
						"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50",
						roomRole === "owner" && "ring-2 ring-success",
						roomRole === "member" && "ring-2 ring-accent",
					)}
				>
					{user.imageUrl ? (
						<img
							src={user.imageUrl}
							alt={user.fullName ?? ""}
							className="w-full h-full object-cover"
						/>
					) : (
						<div className="w-full h-full bg-primary/20 flex items-center justify-center text-xs font-medium text-foreground">
							{(user.fullName ?? user.username ?? "U").charAt(0).toUpperCase()}
						</div>
					)}
				</Menu.Trigger>
				<Menu.Portal>
					<Menu.Positioner side="bottom" align="end" sideOffset={4}>
						<Menu.Popup className="min-w-[160px] rounded-lg bg-background/80 backdrop-liquid border border-border/50 p-1 shadow-lg outline-none">
							<div className="px-3 py-2 border-b border-border/20 mb-1">
								<div className="text-xs font-medium text-foreground truncate">
									{user.fullName ?? user.username}
								</div>
								<div className="text-[10px] text-muted-foreground truncate">
									{user.primaryEmail}
								</div>
							</div>
							<Menu.Item
								onClick={() => signOut()}
								className="flex items-center gap-2 px-3 py-1.5 text-xs text-foreground rounded cursor-pointer outline-none hover:bg-muted focus:bg-muted"
							>
								<LogOut size={14} />
								{t("auth.signOut")}
							</Menu.Item>
						</Menu.Popup>
					</Menu.Positioner>
				</Menu.Portal>
			</Menu.Root>
		</div>
	);
});
