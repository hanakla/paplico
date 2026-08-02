import mitt, {
	type EventType,
	type Handler,
	type Emitter as MittEmitter,
	type WildcardHandler,
} from "mitt";

export class Emitter<Events extends Record<EventType, unknown>> {
	#mitt = mitt<Events>();

	public on(type: "*", handler: WildcardHandler<Events>): () => void;

	public on<Key extends keyof Events>(
		type: Key,
		handler: Handler<Events[Key]>,
	): () => void;

	public on<Key extends keyof Events>(
		type: Key | "*",
		handler: Handler<Events[Key]> | WildcardHandler<Events>,
	) {
		const unlisten = () => {
			this.off(type as any, handler as any);
		};

		this.#mitt.on(type as any, handler as any);
		return unlisten;
	}

	public off: MittEmitter<Events>["off"] = this.#mitt.off.bind(this.#mitt);
	public emit: MittEmitter<Events>["emit"] = this.#mitt.emit.bind(this.#mitt);

	public offAll(): void {
		this.#mitt.all.clear();
	}
}
