/**
 * Batched delivery.
 *
 * Groups results that finish close together into one message.
 *
 * Why this exists rather than Pi's `steeringMode: "all"`: that setting drains whatever
 * happens to be queued when the loop reaches a drain point, but it does not wait.
 * Measured with three jobs finishing at 6s, 7s and 8s, the first was delivered alone and
 * only the later two were grouped. Giving late arrivals a chance to join requires a
 * debounce, which is what this provides.
 *
 * The window runs from the FIRST job of a batch and is not extended by later arrivals:
 * a steadily trickling stream of results would otherwise postpone delivery forever.
 *
 * Separated from the extension so it can be tested without a Pi session.
 */

export interface BatchItem<T> {
	record: T;
	text: string;
}

export interface BatchDeliveryOptions<T> {
	/** How long to hold the first result before releasing the group. */
	windowMs: number;
	/** Called with everything gathered in the window. */
	deliver: (items: Array<BatchItem<T>>) => void;
	/** Injected for tests. */
	setTimeoutFn?: (fn: () => void, ms: number) => unknown;
	clearTimeoutFn?: (handle: unknown) => void;
}

export class BatchCollector<T> {
	private pending: Array<BatchItem<T>> = [];
	private timer: unknown = null;
	private readonly windowMs: number;
	private readonly deliver: (items: Array<BatchItem<T>>) => void;
	private readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
	private readonly clearTimeoutFn: (handle: unknown) => void;

	constructor(options: BatchDeliveryOptions<T>) {
		this.windowMs = options.windowMs;
		this.deliver = options.deliver;
		this.setTimeoutFn = options.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
		this.clearTimeoutFn = options.clearTimeoutFn ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
	}

	/** Add a finished item. Starts the window if this is the first. */
	add(item: BatchItem<T>): void {
		this.pending.push(item);
		if (this.timer === null) {
			this.timer = this.setTimeoutFn(() => this.flush(), this.windowMs);
		}
	}

	/** How many items are currently held. */
	size(): number {
		return this.pending.length;
	}

	/** Is a window currently open? */
	isOpen(): boolean {
		return this.timer !== null;
	}

	/**
	 * Release everything held, if anything. Safe to call at any time - used on shutdown
	 * so a pending result is never silently dropped.
	 */
	flush(): void {
		if (this.timer !== null) {
			this.clearTimeoutFn(this.timer);
			this.timer = null;
		}
		const batch = this.pending;
		this.pending = [];
		if (batch.length === 0) return;
		this.deliver(batch);
	}
}

/**
 * Render a batch as one message.
 *
 * A single item is passed through unchanged; several get a numbered header, because a
 * model reading three concatenated command results needs to know where one ends and the
 * next begins.
 */
export function formatBatch<T>(items: Array<BatchItem<T>>, renderItem: (item: BatchItem<T>) => string): string {
	if (items.length === 0) return "";
	if (items.length === 1) return renderItem(items[0]);
	const parts = items.map((item, index) => `--- ${index + 1}/${items.length} ---\n${renderItem(item)}`);
	return `[${items.length} background jobs finished]\n\n${parts.join("\n\n")}`;
}
