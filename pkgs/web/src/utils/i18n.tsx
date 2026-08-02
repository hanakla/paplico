import { get } from "es-toolkit/compat";
import { createElement, Fragment, type ReactNode, useMemo } from "react";

type Localized<T> = {
	en: T;
	// ja: any
};

// biome-ignore lint/suspicious/noExplicitAny: lib
export const texts = <T extends Localized<any>>(
	t: T,
): Record<keyof T, T["en"]> => t;

// biome-ignore lint/suspicious/noExplicitAny: lib
type TransFn<T extends Localized<any>> = {
	<K extends FlattenKeys<T["en"]>>(key: K): string;

	<K extends FlattenKeys<T["en"]>, P extends Record<string, string | number>>(
		key: K,
		params?: P,
	): string;

	// <K extends keyof T["en"], P extends Record<string, string | ReactNode>>(
	//   key: K,
	//   params?: P
	// ): P extends Record<string, infer R>
	//   ? R extends ReactNode
	//     ? ReactNode
	//     : string
	//   : string;
};

type FlattenKeys<T extends object> = T extends object
	? {
			[K in keyof T]: K extends string
				? T[K] extends object
					? `${K}.${FlattenKeys<T[K]>}`
					: K
				: never;
		}[keyof T]
	: never;

export type TranslationKeys<T extends Localized<any>> = FlattenKeys<T["en"]>;

/**
 * Resolve a translation to a plain string without React.
 * Supports `{{param}}` interpolation only (no ReactNode / `<br/>` handling).
 */
// biome-ignore lint/suspicious/noExplicitAny: lib
export function translateText<T extends Localized<any>>(
	texts: T,
	requestedLocale: string | undefined,
	key: FlattenKeys<T["en"]>,
	params: Record<string, string | number> = {},
): string {
	const locale =
		(["ja", "en"] as const).find((l) => l === requestedLocale) ?? "en";
	const text = get(texts[locale], key);

	if (typeof text !== "string") {
		console.warn(`Missing translation key: ${key}`);
		return key;
	}

	return text.replace(/\{\{(.+?)\}\}/g, (_, name: string) => {
		const value = params[name];
		return value == null ? "" : String(value);
	});
}

// biome-ignore lint/suspicious/noExplicitAny: lib
export function useTranslation<T extends Localized<any>>(
	texts: T,
	requestedLocale?: string,
): TransFn<T> {
	const locale =
		(["ja", "en"] as const).find((l) => l === requestedLocale) ?? "en";

	const localed = texts[locale] as Record<keyof T["en"], string>;

	return useMemo(
		() =>
			<K extends FlattenKeys<T["en"]>>(
				key: K,
				params: Record<string, string | number | ReactNode> = {},
				{ onlyText }: { onlyText?: boolean } = {},
			): any => {
				const text = get(localed, key);
				if (!text) {
					console.warn(`Missing translation key: ${key}`);
					return null;
				}

				let includesVNode = false;
				const children = text
					.split(/((?:\{\{.+?\}\})|(?:<br ?\/>))/g)
					.map((part, i) => {
						if (!onlyText && (part === "<br/>" || part === "<br />")) {
							includesVNode = true;
							// biome-ignore lint/suspicious/noArrayIndexKey: interpolation segments have no stable key
							return <br key={i} />;
						}

						if (!(part.startsWith("{{") && part.endsWith("}}"))) {
							return part;
						}

						const key = part.slice(2, -2);
						const value = params[key];

						if (value == null) return null;
						if (
							typeof value === "string" ||
							typeof value === "number" ||
							typeof value === "boolean"
						) {
							return value.toString();
						}

						includesVNode = true;
						return <>{value}</>;
					})
					.filter(Boolean);

				const next = includesVNode
					? createElement(Fragment, {}, ...children)
					: children.join("");

				return next;
			},
		[localed],
	);
}
