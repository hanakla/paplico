import "./app.css";
import type { Metadata, Viewport } from "next";
import { LiquidGlassFilter } from "@/components/LiquidGlassFilter";
import { TauriInit } from "./TauriInit";

export const viewport: Viewport = {
	viewportFit: "cover",
	width: "device-width",
	initialScale: 1,
	maximumScale: 1,
	userScalable: false,
};

export const metadata: Metadata = {
	appleWebApp: {
		capable: true,
		statusBarStyle: "black-translucent",
	},
};

export default function Layout({ children }: { children: React.ReactNode }) {
	return (
		<html lang="ja">
			<body className="m-0 p-0 overflow-hidden">
				<TauriInit />
				<LiquidGlassFilter />
				{children}
			</body>
		</html>
	);
}
