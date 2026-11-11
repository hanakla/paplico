import type { Migration } from "./index";

/**
 * Changes nothing in the document. The version marks documents in which any
 * element type may carry `isGuide`, and a guide group makes every element
 * inside it a guide. A build that stops at an earlier version reads `isGuide`
 * on paths only: it would paint the other guides as artwork, include them in
 * exports, and drop the flag on its next save. The newer version makes such a
 * build refuse the file, and leave a room at this version alone, instead.
 */
export const migGuideOnAnyElement: Migration = {
	version: 20261112,
	migrate(): void {},
};
