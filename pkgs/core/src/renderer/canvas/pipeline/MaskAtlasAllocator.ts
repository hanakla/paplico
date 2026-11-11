export interface MaskAtlasRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export class MaskAtlasAllocator {
	private freeRects: MaskAtlasRect[];
	/** Whether a release left free rects that may join. They join only when
	 *  an allocation needs them: a pan releases hundreds of masks at once. */
	private hasUnmergedReleases = false;

	public constructor(
		private readonly width: number,
		private readonly height: number,
	) {
		this.freeRects = [{ x: 0, y: 0, width, height }];
	}

	public allocate(width: number, height: number): MaskAtlasRect | null {
		if (width <= 0 || height <= 0) return null;

		let bestIndex = this.findBestFit(width, height);
		if (bestIndex < 0 && this.hasUnmergedReleases) {
			this.mergeFreeRects();
			bestIndex = this.findBestFit(width, height);
		}
		if (bestIndex < 0) return null;

		const free = this.freeRects.splice(bestIndex, 1)[0];
		const allocated = { x: free.x, y: free.y, width, height };
		const remainingWidth = free.width - width;
		const remainingHeight = free.height - height;

		if (remainingWidth > remainingHeight) {
			this.addFreeRect({
				x: free.x + width,
				y: free.y,
				width: remainingWidth,
				height: free.height,
			});
			this.addFreeRect({
				x: free.x,
				y: free.y + height,
				width,
				height: remainingHeight,
			});
		} else {
			this.addFreeRect({
				x: free.x + width,
				y: free.y,
				width: remainingWidth,
				height,
			});
			this.addFreeRect({
				x: free.x,
				y: free.y + height,
				width: free.width,
				height: remainingHeight,
			});
		}

		return allocated;
	}

	public release(rect: MaskAtlasRect): void {
		if (
			rect.width <= 0 ||
			rect.height <= 0 ||
			rect.x < 0 ||
			rect.y < 0 ||
			rect.x + rect.width > this.width ||
			rect.y + rect.height > this.height
		) {
			return;
		}
		this.freeRects.push(rect);
		this.hasUnmergedReleases = true;
	}

	private findBestFit(width: number, height: number): number {
		let bestIndex = -1;
		let bestWaste = Number.POSITIVE_INFINITY;
		for (let i = 0; i < this.freeRects.length; i++) {
			const rect = this.freeRects[i];
			if (width > rect.width || height > rect.height) continue;
			const waste = rect.width * rect.height - width * height;
			if (waste >= bestWaste) continue;
			bestIndex = i;
			bestWaste = waste;
		}
		return bestIndex;
	}

	private addFreeRect(rect: MaskAtlasRect): void {
		if (rect.width > 0 && rect.height > 0) this.freeRects.push(rect);
	}

	private mergeFreeRects(): void {
		this.hasUnmergedReleases = false;
		let previousCount: number;
		do {
			previousCount = this.freeRects.length;
			this.freeRects = mergeRuns(
				mergeRuns(this.freeRects, "x", "width", "y", "height"),
				"y",
				"height",
				"x",
				"width",
			);
		} while (this.freeRects.length < previousCount);
	}
}

/** Join rects that touch end to end along one axis and match across it. */
function mergeRuns(
	rects: readonly MaskAtlasRect[],
	position: "x" | "y",
	length: "width" | "height",
	crossPosition: "x" | "y",
	crossLength: "width" | "height",
): MaskAtlasRect[] {
	const merged: MaskAtlasRect[] = [];
	const sorted = rects.toSorted(
		(a, b) =>
			a[crossPosition] - b[crossPosition] ||
			a[crossLength] - b[crossLength] ||
			a[position] - b[position],
	);
	for (const rect of sorted) {
		const last = merged.at(-1);
		if (
			last &&
			last[crossPosition] === rect[crossPosition] &&
			last[crossLength] === rect[crossLength] &&
			last[position] + last[length] === rect[position]
		) {
			merged[merged.length - 1] = {
				...last,
				[length]: last[length] + rect[length],
			};
			continue;
		}
		merged.push(rect);
	}
	return merged;
}
