import type { Filter } from "../../../schema";
import type { FilterHandler } from "../../canvas/pipeline/FilterRenderer";

/**
 * Handler for the appearance processors (fill, stroke, content). The element
 * renderer draws them itself; registering a handler lets these processors
 * declare what they support, like every other filter.
 */
export class AppearanceFilterHandler implements FilterHandler {
	public readonly usableAsSubFilter = false;

	public async initialize(): Promise<void> {
		/* no-op: the element renderer draws appearances */
	}

	public onScaleFilter(filter: Filter): Filter {
		return filter;
	}

	public getExpansionMargin(): number {
		return 0;
	}
}
