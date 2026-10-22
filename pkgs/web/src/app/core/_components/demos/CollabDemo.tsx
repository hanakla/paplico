"use client";

import type { Paplico } from "@paplico/core";
import { LiveCanvas } from "../LiveCanvas";
import { BroadcastChannelCollaboration } from "./BroadcastChannelCollaboration";
import { builtinBrush, hexToSolidColor } from "./demoSetup";

const CHANNEL_NAME = "paplico-core-site-collab";

const PEERS = [
	{ name: "Alice", color: "#14a2dc" },
	{ name: "Bob", color: "#7cc82a" },
];

/** Two engines side by side, joined through a BroadcastChannel transport. */
export function CollabDemo() {
	return (
		<div className="grid gap-4 md:grid-cols-2">
			{PEERS.map((peer) => (
				<div key={peer.name} className="aero-window">
					<div className="aero-titlebar">
						<span
							className="aero-titlebar-dot"
							style={{ "--aero-dot": peer.color } as React.CSSProperties}
						/>
						<span>{peer.name}’s Paplico</span>
					</div>
					<LiveCanvas
						className="h-[300px]"
						hint={`Draw as ${peer.name}`}
						onReady={(paplico) => joinRoom(paplico, peer.color)}
					/>
				</div>
			))}
		</div>
	);
}

function joinRoom(paplico: Paplico, color: string) {
	const pen = builtinBrush("G-Pen");
	if (pen) paplico.tools.setBrushSettings(pen.settings);
	paplico.tools.setStrokeColor(hexToSolidColor(color));
	paplico.connectCollaboration(
		(ydoc) => new BroadcastChannelCollaboration(ydoc, CHANNEL_NAME),
		{ document: "keepForRemote" },
	);
}
