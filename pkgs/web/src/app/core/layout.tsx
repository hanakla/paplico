import "./aero.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
	title: "Paplico Core — the WebGPU drawing engine for your app",
	description:
		"Brushes, vectors, filters and real-time collaboration on WebGPU. Embed the engine behind Paplico in any web app.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
	return <div data-aero>{children}</div>;
}
