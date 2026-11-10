/** Texture bytes the device destroys before the collector is made to run. */
const DESTROYED_BYTES_PER_COLLECTION = 256 * 1024 * 1024;

/** Size of each buffer held while waiting for the collector. */
const HELD_BUFFER_BYTES = 64 * 1024 * 1024;

/** Most buffers held for one collection. */
const MAX_HELD_BUFFERS = 64;

/** How long a collection waits for the collector to take its sentinel. The
 *  collector is not obliged to report one, and no other collection starts
 *  before this one ends. */
const COLLECTION_DEADLINE_MS = 5000;

/** Destroyed texture bytes uncollected bind groups may keep resident before
 *  renders that can wait are asked to. */
const PINNED_BYTES_BEFORE_HOLD = 768 * 1024 * 1024;

/** How long renders are asked to wait at a time. A bind group the renderer
 *  still references is not collected while renders wait, so the wait has to
 *  end on its own. */
const HOLD_DEADLINE_MS = 5000;

/** A texture of the device, as the bind groups made with it count it. */
interface TrackedTexture {
	readonly bytes: number;
	/** Bind groups made with the texture that the collector has not taken. */
	bindGroups: number;
	isDestroyed: boolean;
}

/** How far the collector is behind the textures a device destroyed. */
export interface DestroyedTextureRelease {
	/** Whether so much destroyed texture memory still waits for the collector
	 *  that a render able to wait should. */
	readonly isBehind: boolean;
	/** Called each time `isBehind` turns false. */
	onCaughtUp: (() => void) | null;
}

/**
 * Make WebKit give back the memory of the textures `device` destroys.
 *
 * WebKit keeps a destroyed GPUTexture resident until every GPUBindGroup made
 * with it is garbage collected. The renderer keeps a bind group as long as
 * its texture, so by the time both are dropped the bind group is old, and
 * only a full collection takes old objects. The renderer allocates little JS
 * memory, so full collections run seconds apart and gigabytes of destroyed
 * textures pile up in between.
 *
 * An ArrayBuffer counts toward the heap size the collector watches without
 * its pages being touched. Once enough texture bytes are destroyed, buffers
 * are allocated and held, one per task, until the collector takes a sentinel
 * as old as the bind groups. A collection that holds all the buffers it may
 * keeps them and waits.
 *
 * What is still resident is counted from the bind groups themselves: a
 * destroyed texture counts until the collector has taken every bind group
 * made with it. Other engines free a texture when it is destroyed and are
 * left alone: for them the result never reports being behind.
 */
export function releaseDestroyedTexturesPromptly(
	device: GPUDevice,
): DestroyedTextureRelease {
	const release: { isBehind: boolean; onCaughtUp: (() => void) | null } = {
		isBehind: false,
		onCaughtUp: null,
	};
	if (!isWebKit()) return release;

	// Bytes destroyed since the last collection began.
	let destroyedBytes = 0;
	let collecting = false;
	let newestCollectedSentinel = -1;
	const sentinels = new FinalizationRegistry<number>((id) => {
		newestCollectedSentinel = Math.max(newestCollectedSentinel, id);
	});
	// Each sentinel is kept until the collection after the one it was made in,
	// so it has lived through a collection the way the bind groups have.
	let agedSentinelId = 0;
	let agedSentinel: object | null = {};
	sentinels.register(agedSentinel, agedSentinelId);

	// Bytes of the destroyed textures a bind group not yet collected was made
	// with.
	let pinnedBytes = 0;
	let holdDeadline: ReturnType<typeof setTimeout> | null = null;
	const endHold = (): void => {
		if (holdDeadline !== null) clearTimeout(holdDeadline);
		holdDeadline = null;
		release.isBehind = false;
		release.onCaughtUp?.();
	};
	const texturesByResource = new WeakMap<object, TrackedTexture>();
	const collectedBindGroups = new FinalizationRegistry<TrackedTexture[]>(
		(textures) => {
			for (const texture of textures) {
				texture.bindGroups--;
				if (texture.isDestroyed && texture.bindGroups === 0) {
					pinnedBytes -= texture.bytes;
				}
			}
			if (release.isBehind && pinnedBytes < PINNED_BYTES_BEFORE_HOLD) {
				endHold();
			}
		},
	);

	const collect = (): void => {
		collecting = true;
		destroyedBytes = 0;
		const awaitedSentinel = agedSentinelId;
		agedSentinelId++;
		agedSentinel = {};
		sentinels.register(agedSentinel, agedSentinelId);

		const held: ArrayBuffer[] = [];
		let canHoldMore = true;
		let isPastDeadline = false;
		const deadline = setTimeout(() => {
			isPastDeadline = true;
		}, COLLECTION_DEADLINE_MS);
		const holdAnother = (): void => {
			if (newestCollectedSentinel < awaitedSentinel && !isPastDeadline) {
				canHoldMore &&= held.length < MAX_HELD_BUFFERS && tryHoldBuffer(held);
				setTimeout(holdAnother, 0);
				return;
			}
			clearTimeout(deadline);
			collecting = false;
			if (destroyedBytes >= DESTROYED_BYTES_PER_COLLECTION) collect();
		};
		// In a task of its own: the frame destroying the textures still
		// references the bind groups.
		setTimeout(holdAnother, 0);
	};

	const createTexture = device.createTexture.bind(device);
	device.createTexture = (descriptor) => {
		const texture = createTexture(descriptor);
		const tracked: TrackedTexture = {
			// A rough size is enough to pace the collections and the hold.
			bytes:
				texture.width *
				texture.height *
				texture.depthOrArrayLayers *
				texture.sampleCount *
				4,
			bindGroups: 0,
			isDestroyed: false,
		};
		texturesByResource.set(texture, tracked);
		const createView = texture.createView.bind(texture);
		texture.createView = (viewDescriptor) => {
			const view = createView(viewDescriptor);
			texturesByResource.set(view, tracked);
			return view;
		};
		const destroy = texture.destroy.bind(texture);
		texture.destroy = () => {
			destroy();
			if (tracked.isDestroyed) return;

			tracked.isDestroyed = true;
			destroyedBytes += tracked.bytes;
			if (tracked.bindGroups > 0) pinnedBytes += tracked.bytes;
			if (!release.isBehind && pinnedBytes >= PINNED_BYTES_BEFORE_HOLD) {
				release.isBehind = true;
				holdDeadline = setTimeout(endHold, HOLD_DEADLINE_MS);
			}
			if (!collecting && destroyedBytes >= DESTROYED_BYTES_PER_COLLECTION) {
				collect();
			}
		};
		return texture;
	};

	const createBindGroup = device.createBindGroup.bind(device);
	device.createBindGroup = (descriptor) => {
		const bindGroup = createBindGroup(descriptor);
		const textures = new Set<TrackedTexture>();
		for (const entry of descriptor.entries) {
			const tracked = texturesByResource.get(entry.resource);
			if (tracked) textures.add(tracked);
		}
		if (textures.size > 0) {
			for (const tracked of textures) {
				if (tracked.isDestroyed && tracked.bindGroups === 0) {
					pinnedBytes += tracked.bytes;
				}
				tracked.bindGroups++;
			}
			collectedBindGroups.register(bindGroup, [...textures]);
		}
		return bindGroup;
	};
	return release;
}

/** Adds one buffer to `held`. Tells whether the allocation succeeded. */
function tryHoldBuffer(held: ArrayBuffer[]): boolean {
	try {
		held.push(new ArrayBuffer(HELD_BUFFER_BYTES));
		return true;
	} catch {
		return false;
	}
}

/** Tells whether the page runs on WebKit, which every browser on iOS does. */
function isWebKit(): boolean {
	if (typeof navigator === "undefined") return false;

	const ua = navigator.userAgent;
	return ua.includes("AppleWebKit") && !/Chrome\/|Chromium\/|Edg\//.test(ua);
}
