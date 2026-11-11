export interface MaskAtlasRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export class MaskAtlasAllocator {
	private readonly freeRects: MaskAtlasRect[];

	public constructor(
		private readonly width: number,
		private readonly height: number,
	) {
		this.freeRects = [{ x: 0, y: 0, width, height }];
	}

	public allocate(width: number, height: number): MaskAtlasRect | null {
		if (width <= 0 || height <= 0) return null;

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
		this.mergeFreeRects();
	}

	private addFreeRect(rect: MaskAtlasRect): void {
		if (rect.width > 0 && rect.height > 0) this.freeRects.push(rect);
	}

	private mergeFreeRects(): void {
		let merged = true;
		while (merged) {
			merged = false;
			outer: for (let i = 0; i < this.freeRects.length; i++) {
				for (let j = i + 1; j < this.freeRects.length; j++) {
					const combined = mergeAdjacentRects(
						this.freeRects[i],
						this.freeRects[j],
					);
					if (!combined) continue;
					this.freeRects.splice(j, 1);
					this.freeRects[i] = combined;
					merged = true;
					break outer;
				}
			}
		}
	}
}

function mergeAdjacentRects(
	a: MaskAtlasRect,
	b: MaskAtlasRect,
): MaskAtlasRect | null {
	if (a.y === b.y && a.height === b.height) {
		if (a.x + a.width === b.x) {
			return { x: a.x, y: a.y, width: a.width + b.width, height: a.height };
		}
		if (b.x + b.width === a.x) {
			return { x: b.x, y: a.y, width: a.width + b.width, height: a.height };
		}
	}

	if (a.x === b.x && a.width === b.width) {
		if (a.y + a.height === b.y) {
			return { x: a.x, y: a.y, width: a.width, height: a.height + b.height };
		}
		if (b.y + b.height === a.y) {
			return { x: a.x, y: b.y, width: a.width, height: a.height + b.height };
		}
	}

	return null;
}
