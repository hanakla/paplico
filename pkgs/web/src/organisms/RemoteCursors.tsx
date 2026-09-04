"use client";

import { useEffect, useRef, useState } from "react";
import { usePaplico, usePaplicoMaybe } from "@/contexts/PaplicoContext";
import { useTargetSize, useTargetViewport } from "@/contexts/ViewIdContext";
import { worldToScreen } from "@/core";
import type { ICollaboration } from "@/core/collaboration/ICollaboration";

interface RemoteCursor {
	clientId: number;
	user: {
		name: string;
		color: string;
		id: string;
	};
	cursor: {
		x: number;
		y: number;
	} | null;
}

export function RemoteCursors() {
	const paplico = usePaplicoMaybe();
	if (!paplico) return null;

	return <RemoteCursorsInner />;
}

function RemoteCursorsInner() {
	const paplico = usePaplico();
	const [remoteCursors, setRemoteCursors] = useState<RemoteCursor[]>([]);
	const viewport = useTargetViewport();
	// Taken from the target rather than passed in, so a resize moves the
	// cursors with it instead of leaving them measured against the old centre.
	const { width: canvasWidth, height: canvasHeight } = useTargetSize();
	const cursorsRef = useRef<Map<number, RemoteCursor>>(new Map());

	useEffect(() => {
		// getCollaboration() is not reactive, so a collaboration attached after
		// this mounted would otherwise go unseen. Re-wiring on
		// collaborationChanged is what picks it up.
		let awareness: ICollaboration["awareness"] | null = null;

		const updateCursors = () => {
			const collaboration = paplico.getCollaboration();
			if (!collaboration) {
				cursorsRef.current = new Map();
				setRemoteCursors([]);
				return;
			}

			const next = new Map<number, RemoteCursor>();
			for (const [clientId, state] of collaboration.getAwarenessStates()) {
				if (clientId === collaboration.localClientId) continue;

				const user = (state as { user?: RemoteCursor["user"] }).user;
				if (!user) continue;

				next.set(clientId, {
					clientId,
					user,
					cursor: (state as { cursor?: RemoteCursor["cursor"] }).cursor ?? null,
				});
			}

			cursorsRef.current = next;
			setRemoteCursors(Array.from(next.values()));
		};

		const wire = () => {
			awareness?.off("change", updateCursors);
			awareness = paplico.getCollaboration()?.awareness ?? null;
			awareness?.on("change", updateCursors);
			updateCursors();
		};

		wire();
		paplico.on("collaborationChanged", wire);

		return () => {
			paplico.off("collaborationChanged", wire);
			awareness?.off("change", updateCursors);
		};
	}, [paplico]);

	return (
		<div className="pointer-events-none absolute inset-0">
			{remoteCursors.map(({ clientId, user, cursor }) => {
				if (!cursor) return null;

				// Convert world coordinates to screen coordinates
				const screenPos = worldToScreen(
					cursor.x,
					cursor.y,
					viewport,
					canvasWidth,
					canvasHeight,
				);

				return (
					<div
						key={clientId}
						className="absolute transition-all duration-75"
						style={{
							left: screenPos.x,
							top: screenPos.y,
							transform: "translate(-2px, -2px)",
						}}
					>
						{/* Cursor dot */}
						<div
							className="w-4 h-4 rounded-full border-2 border-white shadow-lg"
							style={{ backgroundColor: user.color }}
						/>
						{/* User name label */}
						<div
							className="mt-1 px-2 py-1 rounded text-xs text-white font-medium whitespace-nowrap shadow-lg"
							style={{ backgroundColor: user.color }}
						>
							{user.name}
						</div>
					</div>
				);
			})}
		</div>
	);
}
