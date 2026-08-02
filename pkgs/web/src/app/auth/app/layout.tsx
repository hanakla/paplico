import { notFound } from "next/navigation";

const isDev = process.env.NODE_ENV === "development";
const isTauri = process.env.IS_TAURI_ENV === "1";

export default function TauriAuthLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	if (!isDev && !isTauri) notFound();
	return <>{children}</>;
}
