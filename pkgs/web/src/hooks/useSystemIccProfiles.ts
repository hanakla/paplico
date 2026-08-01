import { useEffect, useState } from "react";
import {
	listSystemIccProfiles,
	type SystemIccProfileEntry,
} from "@/infra/systemColorProfiles";
import { IS_TAURI_ENV } from "@/utils/platform";

/**
 * Loads OS-installed ICC profiles (Tauri only). The underlying scan is cached,
 * so repeated mounts are cheap.
 */
export function useSystemIccProfiles(): {
	profiles: SystemIccProfileEntry[];
	loading: boolean;
} {
	const [profiles, setProfiles] = useState<SystemIccProfileEntry[]>([]);
	const [loading, setLoading] = useState(IS_TAURI_ENV);

	useEffect(() => {
		if (!IS_TAURI_ENV) return;

		let cancelled = false;
		setLoading(true);
		listSystemIccProfiles().then((entries) => {
			if (cancelled) return;
			setProfiles(entries);
			setLoading(false);
		});

		return () => {
			cancelled = true;
		};
	}, []);

	return { profiles, loading };
}
