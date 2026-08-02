import { createContext, useContext, useEffect, useState } from "react";
import { appConfig, useAppConfig } from "@/hooks/useAppConfig";
import {
	type TranslationKeys,
	texts,
	translateText,
	useTranslation as useT,
} from "@/utils/i18n";
import { en } from "./en";
import { ja } from "./ja";

export type LocalizeKeys = TranslationKeys<typeof appTexts>;

const appTexts = texts({ en, ja });

/**
 * Forces a language on a subtree regardless of this device's own settings.
 * A remote control should speak the language of the app it is driving, and the
 * page it runs on never went through that app's settings.
 */
const LocaleOverrideContext = createContext<"ja" | "en" | null>(null);

export function LocaleOverrideProvider({
	locale,
	children,
}: {
	locale: "ja" | "en" | null;
	children: React.ReactNode;
}) {
	return (
		<LocaleOverrideContext.Provider value={locale}>
			{children}
		</LocaleOverrideContext.Provider>
	);
}

export const useTranslation = () => {
	const settings = useAppConfig();
	const override = useContext(LocaleOverrideContext);
	const [locale, setLocale] = useState<"ja" | "en">("en");

	useEffect(() => {
		const l = (["ja", "en"] as const).find((l) => l === settings.language);
		if (l) setLocale(l);
	}, [settings.language]);

	return useT(appTexts, override ?? locale);
};

/**
 * Translate a key outside of React (e.g. imperative toast / error report sites).
 * Reads the current language from the appConfig Valtio proxy at call time.
 * Text-only: `{{param}}` interpolation is supported, ReactNode is not.
 */
export function translateStatic(
	key: LocalizeKeys,
	params?: Record<string, string | number>,
): string {
	return translateText(appTexts, appConfig.language, key, params);
}

/** Returns the key's text in every supported locale. */
export function translateAllLocales(key: LocalizeKeys): string[] {
	return (["en", "ja"] as const).map((locale) =>
		translateText(appTexts, locale, key),
	);
}
