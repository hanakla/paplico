import { type ComponentPropsWithoutRef, type MouseEvent, memo } from "react";
import { openExternalUrl } from "@/infra/externalLink";
import { useEventCallback } from "@/utils/hooks";
import { twm } from "@/utils/tailwind";
import type { PropsWithNativeClassName } from "./types";

type Props = PropsWithNativeClassName<ComponentPropsWithoutRef<"a">> & {
	href: string;
};

export const ExternalLink = memo(ExternalLinkRoot);

/**
 * Anchor whose destination always lands in the user's real browser.
 *
 * The click is also held back from an enclosing `<summary>` or clickable row,
 * which would otherwise toggle or select at the same time the link opens.
 */
function ExternalLinkRoot({ href, className, children, ...props }: Props) {
	const handleClick = useEventCallback((e: MouseEvent<HTMLAnchorElement>) => {
		e.preventDefault();
		e.stopPropagation();

		openExternalUrl(e.currentTarget.href).catch((error) => {
			console.error("Failed to open external link", error);
		});
	});

	return (
		<a
			href={href}
			target="_blank"
			rel="noopener noreferrer"
			onClick={handleClick}
			className={twm("outline-none", className)}
			{...props}
		>
			{children}
		</a>
	);
}
