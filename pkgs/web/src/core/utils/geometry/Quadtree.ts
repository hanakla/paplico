/**
 * Quadtree spatial index for efficient bounding box queries
 */

export interface BoundingBox {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

export interface QuadtreeItem<T = unknown> {
	id: string;
	bounds: BoundingBox;
	data: T;
}

interface QuadtreeNode<T> {
	bounds: BoundingBox;
	items: QuadtreeItem<T>[];
	children: QuadtreeNode<T>[] | null;
	depth: number;
}

export class Quadtree<T = unknown> {
	private root: QuadtreeNode<T>;
	private maxItems: number;
	private maxDepth: number;

	public constructor(bounds: BoundingBox, maxItems = 4, maxDepth = 8) {
		this.maxItems = maxItems;
		this.maxDepth = maxDepth;
		this.root = {
			bounds,
			items: [],
			children: null,
			depth: 0,
		};
	}

	/**
	 * Insert an item into the quadtree
	 */
	public insert(item: QuadtreeItem<T>): void {
		this.insertIntoNode(this.root, item);
	}

	private insertIntoNode(node: QuadtreeNode<T>, item: QuadtreeItem<T>): void {
		// If node has children, insert into appropriate child
		if (node.children) {
			const index = this.getQuadrant(node, item.bounds);
			if (index !== -1) {
				this.insertIntoNode(node.children[index], item);
				return;
			}
		}

		// Add item to this node
		node.items.push(item);

		// Split if necessary
		if (
			node.items.length > this.maxItems &&
			node.depth < this.maxDepth &&
			!node.children
		) {
			this.split(node);
		}
	}

	/**
	 * Split a node into 4 children
	 */
	private split(node: QuadtreeNode<T>): void {
		const { bounds, depth } = node;
		const midX = (bounds.minX + bounds.maxX) / 2;
		const midY = (bounds.minY + bounds.maxY) / 2;

		// Create 4 children (NW, NE, SW, SE)
		node.children = [
			// NW (top-left)
			{
				bounds: {
					minX: bounds.minX,
					minY: midY,
					maxX: midX,
					maxY: bounds.maxY,
				},
				items: [],
				children: null,
				depth: depth + 1,
			},
			// NE (top-right)
			{
				bounds: {
					minX: midX,
					minY: midY,
					maxX: bounds.maxX,
					maxY: bounds.maxY,
				},
				items: [],
				children: null,
				depth: depth + 1,
			},
			// SW (bottom-left)
			{
				bounds: {
					minX: bounds.minX,
					minY: bounds.minY,
					maxX: midX,
					maxY: midY,
				},
				items: [],
				children: null,
				depth: depth + 1,
			},
			// SE (bottom-right)
			{
				bounds: {
					minX: midX,
					minY: bounds.minY,
					maxX: bounds.maxX,
					maxY: midY,
				},
				items: [],
				children: null,
				depth: depth + 1,
			},
		];

		// Redistribute items into children
		const items = node.items;
		node.items = [];

		for (const item of items) {
			const index = this.getQuadrant(node, item.bounds);
			if (index !== -1) {
				this.insertIntoNode(node.children[index], item);
			} else {
				// Item doesn't fit in any quadrant, keep in parent
				node.items.push(item);
			}
		}
	}

	/**
	 * Get the quadrant index for a bounding box
	 * Returns -1 if the box doesn't fit entirely in any quadrant
	 */
	private getQuadrant(node: QuadtreeNode<T>, bounds: BoundingBox): number {
		if (!node.children) return -1;

		const midX = (node.bounds.minX + node.bounds.maxX) / 2;
		const midY = (node.bounds.minY + node.bounds.maxY) / 2;

		const topHalf = bounds.minY >= midY;
		const bottomHalf = bounds.maxY <= midY;
		const leftHalf = bounds.maxX <= midX;
		const rightHalf = bounds.minX >= midX;

		if (topHalf && leftHalf) return 0; // NW
		if (topHalf && rightHalf) return 1; // NE
		if (bottomHalf && leftHalf) return 2; // SW
		if (bottomHalf && rightHalf) return 3; // SE

		return -1; // Doesn't fit in any single quadrant
	}

	/**
	 * Query all items that intersect with the given bounds
	 */
	public query(bounds: BoundingBox): QuadtreeItem<T>[] {
		const results: QuadtreeItem<T>[] = [];
		this.queryNode(this.root, bounds, results);
		return results;
	}

	private queryNode(
		node: QuadtreeNode<T>,
		bounds: BoundingBox,
		results: QuadtreeItem<T>[],
	): void {
		// Check if search bounds intersect with node bounds
		if (!this.intersects(node.bounds, bounds)) {
			return;
		}

		// Check items in this node
		for (const item of node.items) {
			if (this.intersects(item.bounds, bounds)) {
				results.push(item);
			}
		}

		// Check children
		if (node.children) {
			for (const child of node.children) {
				this.queryNode(child, bounds, results);
			}
		}
	}

	/**
	 * Check if two bounding boxes intersect
	 */
	private intersects(a: BoundingBox, b: BoundingBox): boolean {
		return !(
			a.maxX < b.minX ||
			a.minX > b.maxX ||
			a.maxY < b.minY ||
			a.minY > b.maxY
		);
	}

	/**
	 * Find an item by ID
	 */
	public find(id: string): QuadtreeItem<T> | null {
		return this.findInNode(this.root, id);
	}

	private findInNode(
		node: QuadtreeNode<T>,
		id: string,
	): QuadtreeItem<T> | null {
		// Check items in this node
		for (const item of node.items) {
			if (item.id === id) return item;
		}

		// Check children
		if (node.children) {
			for (const child of node.children) {
				const found = this.findInNode(child, id);
				if (found) return found;
			}
		}

		return null;
	}

	/**
	 * Remove an item by ID
	 */
	public remove(id: string): boolean {
		return this.removeFromNode(this.root, id);
	}

	private removeFromNode(node: QuadtreeNode<T>, id: string): boolean {
		// Try to remove from this node's items
		const index = node.items.findIndex((item) => item.id === id);
		if (index !== -1) {
			node.items.splice(index, 1);
			return true;
		}

		// Try to remove from children
		if (node.children) {
			for (const child of node.children) {
				if (this.removeFromNode(child, id)) {
					return true;
				}
			}
		}

		return false;
	}

	/**
	 * Clear all items from the quadtree
	 */
	public clear(): void {
		this.root.items = [];
		this.root.children = null;
	}

	/**
	 * Get all items in the quadtree
	 */
	public getAll(): QuadtreeItem<T>[] {
		const results: QuadtreeItem<T>[] = [];
		this.getAllFromNode(this.root, results);
		return results;
	}

	private getAllFromNode(
		node: QuadtreeNode<T>,
		results: QuadtreeItem<T>[],
	): void {
		results.push(...node.items);

		if (node.children) {
			for (const child of node.children) {
				this.getAllFromNode(child, results);
			}
		}
	}

	/**
	 * Get the total number of items in the quadtree
	 */
	public size(): number {
		return this.sizeOfNode(this.root);
	}

	private sizeOfNode(node: QuadtreeNode<T>): number {
		let count = node.items.length;

		if (node.children) {
			for (const child of node.children) {
				count += this.sizeOfNode(child);
			}
		}

		return count;
	}
}
