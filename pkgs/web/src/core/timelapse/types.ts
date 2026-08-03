/** Yjs update の1エントリ */
export interface TimelapseEntry {
	/** recording start からの相対時間 (ms) */
	t: number;
	/** Yjs binary update (cbor-x) */
	u: Uint8Array;
}

/** タイムラプスデータ全体（Document.timelapse に格納） */
export interface TimelapseData {
	version: 1;
	entries: TimelapseEntry[];
}

/** 再生状態（UI向け） */
export interface PlaybackState {
	isPlaying: boolean;
	/** 現在のイベントインデックス */
	currentIndex: number;
	/** 全イベント数 */
	totalEvents: number;
	/** 再生速度 (1, 2, 5, 10) */
	speed: number;
	/** アニメーション中のパス進捗 (0-1, null = アニメーションなし) */
	pathAnimProgress: number | null;
	/** Intro phase: "complete" = showing finished work, "fadeOut" = fading to blank, null = normal playback */
	introPhase: "complete" | "fadeOut" | null;
}
