const RECONNECT_KEY = "paplico:reconnectInfo";

interface ReconnectInfo {
	roomId: string;
	documentId: string;
}

export function getReconnectInfo(): ReconnectInfo | null {
	try {
		const raw = sessionStorage.getItem(RECONNECT_KEY);
		return raw ? JSON.parse(raw) : null;
	} catch {
		return null;
	}
}

export function setReconnectInfo(info: ReconnectInfo | null): void {
	try {
		if (info) sessionStorage.setItem(RECONNECT_KEY, JSON.stringify(info));
		else sessionStorage.removeItem(RECONNECT_KEY);
	} catch {
		// Reconnect persistence is best-effort.
	}
}
