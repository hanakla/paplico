import type { Metadata } from "next";

export const metadata: Metadata = { title: "Paplico" };

export default function AuthRelayLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	return <>{children}</>;
}
