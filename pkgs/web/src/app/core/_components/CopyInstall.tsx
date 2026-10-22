"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";

const COMMAND = "npm install @paplico/core";

/** The install command as a glass pill that copies itself on click. */
export function CopyInstall() {
	const [copied, setCopied] = useState(false);

	const copy = async () => {
		await navigator.clipboard.writeText(COMMAND);
		setCopied(true);
		setTimeout(() => setCopied(false), 1500);
	};

	return (
		<button
			type="button"
			onClick={copy}
			className="aero-glass inline-flex items-center gap-3 rounded-full! px-4 py-2 font-mono text-sm text-sky-950"
		>
			<span className="text-sky-600">$</span>
			{COMMAND}
			{copied ? (
				<Check className="size-4 text-lime-600" />
			) : (
				<Copy className="size-4 text-sky-700/70" />
			)}
		</button>
	);
}
