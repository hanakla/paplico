import { readIccProfileDescription } from "@/core/color/ColorEngine";
import { inspectIccProfile } from "@/core/color/IccProfileRegistry";
import { IS_TAURI_ENV } from "@/utils/platform";

/** A color profile discovered in an OS-standard ColorSync / color directory. */
export interface SystemIccProfileEntry {
	path: string;
	fileName: string;
	/** ICC 'desc' tag name; falls back to fileName when it cannot be read. */
	description: string;
	colorSpace: "rgb" | "cmyk" | "gray" | "other";
	bytes: Uint8Array;
}

const ICC_FILE_EXTENSIONS = [".icc", ".icm"];

let systemProfilesPromise: Promise<SystemIccProfileEntry[]> | null = null;

/**
 * Enumerates ICC profiles installed in the OS-standard color directories.
 * Tauri only; returns [] in the browser. The result is cached for the session.
 */
export function listSystemIccProfiles(): Promise<SystemIccProfileEntry[]> {
	if (!IS_TAURI_ENV) return Promise.resolve([]);
	systemProfilesPromise ??= loadSystemIccProfiles().catch(() => {
		// Drop a failed scan so a later call can retry.
		systemProfilesPromise = null;
		return [];
	});
	return systemProfilesPromise;
}

async function loadSystemIccProfiles(): Promise<SystemIccProfileEntry[]> {
	const fs = await import("@tauri-apps/plugin-fs");
	const directories = await resolveSystemProfileDirectories();

	// Directories are ordered by priority (user first); the first occurrence of
	// a profile wins so a user override shadows the system copy.
	const seen = new Set<string>();
	const entries: SystemIccProfileEntry[] = [];

	for (const dir of directories) {
		const dirEntries = await readDirSafe(fs, dir);
		for (const dirEntry of dirEntries) {
			if (!dirEntry.isFile || !isIccFileName(dirEntry.name)) continue;

			const path = joinPath(dir, dirEntry.name);
			const entry = await readProfileEntry(fs, path, dirEntry.name);
			if (!entry) continue;

			const dedupKey = `${entry.description} ${entry.colorSpace}`;
			if (seen.has(dedupKey)) continue;
			seen.add(dedupKey);
			entries.push(entry);
		}
	}

	entries.sort((a, b) => a.description.localeCompare(b.description));
	return entries;
}

/** Resolves the OS-standard color directories ordered by priority (user first). */
async function resolveSystemProfileDirectories(): Promise<string[]> {
	const platform = navigator.userAgent.toLowerCase();

	if (platform.includes("windows")) {
		const systemRoot =
			(globalThis as { SystemRoot?: string }).SystemRoot ?? "C:\\Windows";
		return [`${systemRoot}\\System32\\spool\\drivers\\color`];
	}

	// macOS (and other Unix-likes): user dir takes priority over /Library, /System.
	const { homeDir } = await import("@tauri-apps/api/path");
	let userColorSync: string | null = null;
	try {
		const home = await homeDir();
		userColorSync = joinPath(home, "Library/ColorSync/Profiles");
	} catch {
		userColorSync = null;
	}

	return [
		userColorSync,
		"/Library/ColorSync/Profiles",
		"/System/Library/ColorSync/Profiles",
	].filter((dir): dir is string => dir !== null);
}

async function readDirSafe(
	fs: typeof import("@tauri-apps/plugin-fs"),
	dir: string,
): Promise<{ name: string; isFile: boolean }[]> {
	try {
		return await fs.readDir(dir);
	} catch {
		// Missing or permission-blocked directory (e.g. sandboxed /System/Library).
		return [];
	}
}

async function readProfileEntry(
	fs: typeof import("@tauri-apps/plugin-fs"),
	path: string,
	fileName: string,
): Promise<SystemIccProfileEntry | null> {
	try {
		const bytes = await fs.readFile(path);
		const inspected = inspectIccProfile(bytes);
		if (!inspected) return null;

		const description = (await readIccProfileDescription(bytes)) ?? fileName;
		return {
			path,
			fileName,
			description,
			colorSpace: inspected.colorSpace,
			bytes,
		};
	} catch {
		return null;
	}
}

function isIccFileName(name: string): boolean {
	const lower = name.toLowerCase();
	return ICC_FILE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function joinPath(dir: string, name: string): string {
	const separator = dir.includes("\\") ? "\\" : "/";
	return dir.endsWith(separator)
		? `${dir}${name}`
		: `${dir}${separator}${name}`;
}
