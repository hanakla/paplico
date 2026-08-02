import type { Metadata } from "next";
import { CompanionApp } from "./CompanionApp";

export const metadata: Metadata = {
	title: "Paplico Companion",
};

export default function CompanionPage() {
	return <CompanionApp />;
}
