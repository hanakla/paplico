import type { TimelapseData, TimelapseEntry } from "./types";

/**
 * Yjs update をタイムスタンプ付きで記録する。
 */
export class TimelapseRecorder {
	private entries: TimelapseEntry[] = [];
	private startedAt = Date.now();

	/** ydoc.on("update") から呼ばれる */
	public onYjsUpdate(update: Uint8Array): void {
		this.entries.push({
			t: Date.now() - this.startedAt,
			u: update,
		});
	}

	public getTimelapseData(): TimelapseData | null {
		if (this.entries.length === 0) return null;
		return { version: 1, entries: this.entries };
	}

	/** CBOR import 時に既存データを復元し、追記を続ける */
	public restoreFrom(data: TimelapseData): void {
		this.entries = [...data.entries];
		const lastT = this.entries.at(-1)?.t ?? 0;
		this.startedAt = Date.now() - lastT;
	}
}
