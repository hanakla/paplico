import { mergeProps, useRender } from "@base-ui/react";
import { type JSX, type KeyboardEventHandler, useRef } from "react";
import { useEventCallback } from "@/utils/hooks";

type Props<T extends keyof JSX.IntrinsicElements> = {
	as?: T;
	onKeyDown?: KeyboardEventHandler<Element>;
} & Omit<JSX.IntrinsicElements[T], "onKeyDown">;

export function Clickable<T extends keyof JSX.IntrinsicElements>({
	as = "div" as T,
	onKeyDown,
	...props
}: Props<T>) {
	const ref = useRef<HTMLElement>(null);

	const handleKeyDown = useEventCallback(
		(event: React.KeyboardEvent<Element>) => {
			onKeyDown?.(event);

			if (event.isDefaultPrevented() || event.isPropagationStopped()) return;

			if (
				(!event.nativeEvent.isComposing && event.key === "Enter") ||
				event.key === " "
			) {
				ref.current?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			}
		},
	);

	return useRender({
		defaultTagName: as,
		ref,
		props: mergeProps(props, { tabIndex: 0, onKeyDown: handleKeyDown }),
	});
}
