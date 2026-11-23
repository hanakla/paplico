/**
 * One level the user has stepped into. An element scope narrows editing to a
 * container's children, or to a single element. A layer scope narrows it to a
 * layer an editing session lends the tools, such as the pattern or mask
 * editor's working layer. A repeat instance scope narrows editing to a
 * repeat's sources, placed where its `instanceIndex`-th copy is drawn, so the
 * user edits them on that copy and every copy follows.
 */
export type EditingScope =
	| { kind: "element"; id: string }
	| { kind: "layer"; id: string }
	| { kind: "repeatInstance"; id: string; instanceIndex: number };
