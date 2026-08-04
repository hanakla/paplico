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
	 * ドキュメントが差し替わったので、記録を最初からやり直す。
	 *
	 * `baseline` は差し替え直後の Yjs 状態を丸ごとエンコードしたもの。ここを
	 * 差分にしてはいけない。差し替えが出す更新は、直前まで存在していた
	 * アイテムを前提にした差分で、その依存を作った更新はもう記録に無い。
	 * 空の Y.Doc に再生しても Yjs が統合できず、何も現れなくなる。
	 *
	 * 差し替え前の記録は引き継げない。過去の記録が作るアイテムと、差し替え後の
	 * Yjs が持つアイテムは別物なので、連結して再生するとレイヤーが二重になる。
	 * 切り替えたら録り直す。
	 */
	public restartFrom(baseline: Uint8Array): void {
		this.startedAt = Date.now();
		this.entries = [{ t: 0, u: baseline }];
		this.rects = [null];
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
