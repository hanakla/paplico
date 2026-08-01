"use client";

import { Check, Copy, History, X as XIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { createCallable } from "react-call";
import { Button } from "@/components/Button";
import { Dialog } from "@/components/Dialog";
import { useUserSession } from "@/hooks/useUserSession";
import { useTranslation } from "@/locales/index";
import { useEventCallback } from "@/utils/hooks";

type Room = {
	room_id: string;
	owner_user_id: string;
	created_at: string;
	closed_at: string | null;
};

export const RoomHistoryDialog = createCallable<Record<string, never>, void>(
	({ call }) => {
		const { getToken } = useUserSession();
		const t = useTranslation();
		const [rooms, setRooms] = useState<Room[]>([]);
		const [loading, setLoading] = useState(true);
		const [error, setError] = useState<string | null>(null);
		const [copiedId, setCopiedId] = useState<string | null>(null);

		useEffect(() => {
			let cancelled = false;
			const errMsg = t("roomHistoryDialog.error");

			(async () => {
				const token = await getToken();
				if (!token || cancelled) {
					setLoading(false);
					return;
				}

				try {
					const res = await fetch("/api/rooms", {
						headers: { Authorization: `Bearer ${token}` },
					});

					if (!res.ok) {
						setError(errMsg);
						setLoading(false);
						return;
					}

					const data = await res.json();
					if (!cancelled) setRooms(data);
				} catch {
					if (!cancelled) setError(errMsg);
				} finally {
					if (!cancelled) setLoading(false);
				}
			})();

			return () => {
				cancelled = true;
			};
		}, [getToken, t]);

		const handleCopyRoomId = useEventCallback((roomId: string) => {
			navigator.clipboard.writeText(roomId);
			setCopiedId(roomId);
			setTimeout(() => setCopiedId(null), 2000);
		});

		const handleOpenChange = useEventCallback((open: boolean) => {
			if (!open) call.end();
		});

		return (
			<Dialog.Root open onOpenChange={handleOpenChange}>
				<Dialog.Content className="w-[420px] p-0 flex flex-col max-h-[80vh]">
					{/* Header */}
					<div className="flex items-center justify-between px-4 py-3 border-b border-border/30">
						<Dialog.Title className="text-sm font-medium mb-0 flex items-center gap-2">
							<History size={16} />
							{t("roomHistoryDialog.title")}
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

					{/* Content */}
					<div className="flex-1 overflow-y-auto p-4">
						{loading && (
							<p className="text-sm text-muted-foreground text-center py-4">
								{t("roomHistoryDialog.loading")}
							</p>
						)}

						{error && (
							<p className="text-sm text-danger text-center py-4">{error}</p>
						)}

						{!loading && !error && rooms.length === 0 && (
							<p className="text-sm text-muted-foreground text-center py-4">
								{t("roomHistoryDialog.empty")}
							</p>
						)}

						{!loading && !error && rooms.length > 0 && (
							<div className="space-y-2">
								{rooms.map((room) => (
									<RoomRow
										key={room.room_id}
										room={room}
										copied={copiedId === room.room_id}
										onCopy={handleCopyRoomId}
										t={t}
									/>
								))}
							</div>
						)}
					</div>

					{/* Footer */}
					<div className="flex justify-end px-4 py-3 border-t border-border/30">
						<Button $variant="ghost" $size="sm" onClick={() => call.end()}>
							{t("roomHistoryDialog.close")}
						</Button>
					</div>
				</Dialog.Content>
			</Dialog.Root>
		);
	},
);

function RoomRow({
	room,
	copied,
	onCopy,
	t,
}: {
	room: Room;
	copied: boolean;
	onCopy: (roomId: string) => void;
	t: ReturnType<typeof useTranslation>;
}) {
	return (
		<div className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-border/30 hover:bg-foreground/5 transition-colors">
			<div className="flex-1 min-w-0">
				<code className="text-xs text-muted-foreground block truncate">
					{room.room_id}
				</code>
				<div className="flex items-center gap-2 mt-1">
					<span className="text-xs text-muted-foreground">
						{formatDate(room.created_at)}
					</span>
					{room.closed_at ? (
						<span className="text-[10px] px-1.5 py-0.5 rounded bg-muted/50 text-muted-foreground">
							{t("roomHistoryDialog.closed")}
						</span>
					) : (
						<span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/10 text-accent">
							{t("roomHistoryDialog.active")}
						</span>
					)}
				</div>
			</div>
			<button
				type="button"
				onClick={() => onCopy(room.room_id)}
				className="p-2 rounded hover:bg-foreground/10 transition-colors shrink-0"
				title={t("roomHistoryDialog.copied")}
			>
				{copied ? (
					<Check size={14} className="text-accent" />
				) : (
					<Copy size={14} />
				)}
			</button>
		</div>
	);
}

function formatDate(iso: string): string {
	const date = new Date(iso);
	return date.toLocaleDateString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}
