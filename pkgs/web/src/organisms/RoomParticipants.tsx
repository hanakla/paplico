"use client";

import { UserX } from "lucide-react";
import { memo, useEffect, useState } from "react";
import { Tooltip } from "@/components/Tooltip";
import { usePaplicoMaybe } from "@/contexts/PaplicoContext";
import { useTranslation } from "@/locales";

interface RoomUser {
	clientId: number;
	name: string;
	color: string;
	id: string;
}

export const RoomParticipants = memo(function RoomParticipants({
	connectedRoomId,
	isOwner = false,
}: {
	connectedRoomId: string | null;
	isOwner?: boolean;
}) {
	const paplico = usePaplicoMaybe();
	if (!paplico || !connectedRoomId) return null;

	return <RoomParticipantsInner isOwner={isOwner} />;
});

function RoomParticipantsInner({ isOwner }: { isOwner: boolean }) {
	const paplico = usePaplicoMaybe()!;
	const [users, setUsers] = useState<RoomUser[]>([]);
	const collaboration = paplico.getCollaboration();
	const t = useTranslation();

	useEffect(() => {
		if (!collaboration) {
			setUsers([]);
			return;
		}

		const updateUsers = () => {
			const states = collaboration.getAwarenessStates();
			const remoteUsers: RoomUser[] = [];

			states.forEach((state: any, clientId: number) => {
				if (clientId === collaboration.localClientId) return;
				if (!state.user) return;

				remoteUsers.push({
					clientId,
					name: state.user.name,
					color: state.user.color,
					id: state.user.id,
				});
			});

			setUsers(remoteUsers);
		};

		collaboration.awareness.on("change", updateUsers);
		updateUsers();

		return () => {
			collaboration.awareness.off("change", updateUsers);
		};
	}, [collaboration]);

	const handleKick = async (user: RoomUser) => {
		if (!collaboration) return;
		if (
			!(await confirm(t("connectRoomDialog.kickConfirm", { name: user.name })))
		)
			return;
		collaboration.kickUser(user.clientId);
	};

	if (users.length === 0) return null;

	return (
		<div className="flex items-center -space-x-1.5">
			{users.map((user) => (
				<Tooltip
					key={user.clientId}
					content={
						isOwner ? (
							<button
								type="button"
								onClick={() => handleKick(user)}
								className="flex items-center gap-1.5 text-xs hover:text-destructive transition-colors"
							>
								<UserX size={12} />
								{t("connectRoomDialog.kick")} {user.name}
							</button>
						) : (
							user.name
						)
					}
				>
					<div
						className="w-6 h-6 rounded-full overflow-hidden border-2 border-background/80 shrink-0 cursor-default"
						style={{ zIndex: user.clientId }}
					>
						<div
							className="w-full h-full flex items-center justify-center text-[10px] font-medium text-white"
							style={{ backgroundColor: user.color }}
						>
							{user.name.charAt(0).toUpperCase()}
						</div>
					</div>
				</Tooltip>
			))}
		</div>
	);
}
