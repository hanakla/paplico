import type { BoundingBox } from "../schema";
import {
	TimelapseBoundsLedger,
	type TimelapseChangeSet,
} from "./timelapseIndex";
import type {
	TimelapseData,
	TimelapseDirtyRect,
	TimelapseEntry,
	TimelapseIndex,
} from "./types";

/**
 * Yjs update をタイムスタンプ付きで記録し、併せて各更新が変化させた
 * ワールド矩形を残す。矩形は再生時にアートボード外の更新を弾くために使う。
 */
export class TimelapseRecorder {
	private entries: TimelapseEntry[] = [];
	private rects: (TimelapseDirtyRect | null)[] = [];
	private startedAt = Date.now();
	private readonly ledger = new TimelapseBoundsLedger();

	public constructor(
		private readonly getWorldBounds: (id: string) => BoundingBox | null,
	) {}

	/**
	 * ydoc.on("update") から呼ばれる。
	 * `changes` が null の更新（full sync / replaceDocument / レイヤーのみの変更）は
	 * 影響範囲不明として記録し、再生時は常に描画される。
	 */
	public onYjsUpdate(
		update: Uint8Array,
		changes: TimelapseChangeSet | null,
	): void {
		this.entries.push({
			t: Date.now() - this.startedAt,
			u: update,
		});
		this.rects.push(this.ledger.track(changes, this.getWorldBounds));
	}

	/**
	 * ドキュメントが丸ごと差し替わった後に台帳を張り直す。
	 * 張り直さないと、差し替え前から存在する要素の「移動前の位置」を見失い、
	 * アートボードから出ていく更新を取りこぼす。
	 */
	public seedBounds(elementIds: Iterable<string>): void {
		this.ledger.seed(elementIds, this.getWorldBounds);
	}

	public getTimelapseData(): TimelapseData | null {
		if (this.entries.length === 0) return null;
		return {
			version: 2,
			entries: this.entries,
			index: { rects: this.rects },
		};
	}

	/**
	 * 差し替わったドキュメントの記録を引き継ぎ、追記を続ける。
	 * Recorder はドキュメントより長く生きるので、記録を持たないドキュメントに
	 * 切り替わったときは undefined を渡して空から録り直す。渡さないと前の
	 * ドキュメントの履歴がそのまま再生されてしまう。
	 */
	public restoreFrom(data: TimelapseData | undefined): void {
		this.entries = data ? [...data.entries] : [];
		this.rects = data?.index
			? [...data.index.rects]
			: new Array<TimelapseDirtyRect | null>(this.entries.length).fill(null);
		const lastT = this.entries.at(-1)?.t ?? 0;
		this.startedAt = Date.now() - lastT;
	}

	/**
	 * インデックスの無い録画から再構築した矩形を受け取り、未知のままだった
	 * ぶんだけを埋める。再構築中に追記されたエントリの矩形は記録済みなので
	 * 触らない。
	 */
	public adoptRebuiltIndex(index: TimelapseIndex): void {
		const count = Math.min(index.rects.length, this.rects.length);
		for (let i = 0; i < count; i++) {
			this.rects[i] ??= index.rects[i];
		}
	}
}
