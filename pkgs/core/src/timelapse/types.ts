import type { ChangedElements } from "../renderer/types";
import type { Document } from "../schema";

/** Yjs update の1エントリ */
export interface TimelapseEntry {
	/** recording start からの相対時間 (ms) */
	t: number;
	/** Yjs binary update (cbor-x) */
	u: Uint8Array;
}

/**
 * ワールド空間の矩形 `[minX, minY, maxX, maxY]`。
 * 1エントリが変化させた領域を、変更前と変更後の和集合で表す。
 */
export type TimelapseDirtyRect = readonly [
	minX: number,
	minY: number,
	maxX: number,
	maxY: number,
];

/**
 * エントリごとの影響範囲。アートボード外の更新を、Yjs に触らずに弾くために使う。
 * `rects` は entries と同じ長さで、`null` は「影響範囲不明」を表す。
 * 不明なエントリは常に「影響あり」として扱うので、間引きが甘くなるだけで
 * 表示が欠けることはない。
 */
export interface TimelapseIndex {
	rects: (TimelapseDirtyRect | null)[];
}

/** タイムラプスデータ全体（Document.timelapse に格納） */
export interface TimelapseData {
	version: 2;
	entries: TimelapseEntry[];
	/** 未計算なら undefined。読込時に一度だけ再構築して埋める */
	index?: TimelapseIndex;
	/**
	 * それ単体で完結した状態を持つエントリの位置。
	 *
	 * ドキュメントを切り替えると、それ以降の更新は切り替え前とは別のアイテムに
	 * 対する差分になる。再生側はここで replay ドキュメントを作り直す。作り直さ
	 * ずに繋げて再生すると、同じレイヤーが二重に積まれる。
	 */
	baselines?: number[];
	/**
	 * Schema version the entries were recorded in, ascending by `at`. Entries
	 * from `at` up to the next mark carry data shaped by `version`.
	 *
	 * Runs recorded by an older build never went through the migrations that
	 * came after it, so playback migrates what it replays from this version.
	 */
	schemaVersions?: { at: number; version: number }[];
}

/** One replayed frame and what it changed since the frame handed out before it. */
export interface TimelapseFrame {
	document: Document;
	/** undefined: every element may have changed since the previous frame */
	changedElements: ChangedElements | undefined;
}

/** 再生状態（UI向け） */
export interface PlaybackState {
	isPlaying: boolean;
	/** インデックスの無い録画を再構築中。完了するまでシーク位置は動かせない */
	isPreparing: boolean;
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
