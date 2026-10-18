/**
 * Channel renderer registry.
 *
 * The framework knows how to run a process, track it, kill it, persist it and deliver its
 * result. It does not know how to read any particular channel's output stream. That
 * knowledge belongs to the extension that contributes the channel.
 *
 * Before this registry existed, `index.ts` carried
 * `record.channel === "x" ? renderForX(...) : renderForGeneric(...)`
 * inside its delivery callback - a hardcoded branch on another extension's vocabulary,
 * plus an import of that extension's module. Installing the framework alone, or the
 * channel alone, could not work.
 *
 * Consequences worth stating, because they are the reason for the indirection:
 *   - adding a channel needs no edit to this package
 *   - a channel extension can be uninstalled without breaking delivery for the rest
 *   - a job whose renderer never registered still delivers, via the fallback below
 */

import type { ChannelRenderer, JobRecord, ChannelRenderContext } from "./types.ts";

const registry = new Map<string, ChannelRenderer>();

/**
 * Register a channel's renderer.
 *
 * Re-registering the same name replaces the previous entry: an extension reload should
 * end up with exactly one renderer per name, not a growing pile of stale ones.
 *
 * Returns an unregister function so the owner can clean up on shutdown.
 */
export function registerChannel(renderer: ChannelRenderer): () => void {
	registry.set(renderer.name, renderer);
	return () => {
		// Only remove it if it is still ours; a later registration may have replaced it.
		if (registry.get(renderer.name) === renderer) registry.delete(renderer.name);
	};
}

export function getChannel(name: string): ChannelRenderer | undefined {
	return registry.get(name);
}

/** Names currently registered, for diagnostics. */
export function registeredChannels(): string[] {
	return [...registry.keys()];
}

/**
 * The text a settled job contributes to the delivery batch.
 *
 * Falls back to the record's own output when no renderer is registered. This matters
 * more than it looks: the alternative is a thrown error inside a delivery callback, and
 * `notifyFinish` swallows those - the result would be silently dropped. A plain
 * passthrough is always better than a lost answer.
 */
export function renderForDelivery(record: JobRecord, ctx: ChannelRenderContext): string {
	const renderer = registry.get(record.channel);
	if (renderer) {
		try {
			// An empty render is as much a loss as a thrown one: the delivery batch would carry
			// a blank result and look identical to a job that said nothing. Fall back instead.
			const out = renderer.render(record, ctx);
			return out || fallbackRender(record);
		} catch {
			/* fall through to the plain form rather than lose the result */
		}
	}
	return fallbackRender(record);
}

/**
 * Render a settled job, then persist whatever the renderer wrote back onto the record.
 *
 * The ordering is the entire point. `engine.finish` writes the record to disk BEFORE any
 * delivery callback runs, so a renderer that records facts on the record (a channel may keep
 * the session id and tool-call count in `record.stats`) would leave them
 * in memory only - they vanish on the next session and the digest's "N tool calls" shows
 * 0. Persisting here is the write the old `engine.deliver` did after formatting; batching
 * delivery away dropped it, which was a real regression.
 *
 * It is a separate function rather than two lines at the call site so that a test can
 * pin the ordering: without it, "a green suite" proves nothing about this path.
 */
export function renderAndPersist(
	record: JobRecord,
	ctx: ChannelRenderContext,
	persist: (record: JobRecord) => void,
): string {
	const text = renderForDelivery(record, ctx);
	persist(record);
	return text;
}

/** One-line state for the job list, where a channel may have something terser to say. */
export function digestFor(record: JobRecord): string {
	const renderer = registry.get(record.channel);
	if (renderer?.digest) {
		try {
			const out = renderer.digest(record);
			return out || `${record.state}${record.exitCode !== undefined ? ` (exit ${String(record.exitCode)})` : ""}`;
		} catch {
			/* fall through */
		}
	}
	return `${record.state}${record.exitCode !== undefined ? ` (exit ${String(record.exitCode)})` : ""}`;
}

/**
 * Plain rendering used when a channel has no renderer.
 *
 * Deliberately dumb: state, exit code, output. No channel-specific decoration, because
 * this is exactly the path taken when nobody knows how to decorate.
 */
function fallbackRender(record: JobRecord): string {
	const head = `[Job ${record.id} ${record.state}]`;
	const body = record.output?.trim() || record.error || "(no output)";
	return `${head}\n${body}`;
}

/** Test hook: drop everything, so one test file cannot leak renderers into the next. */
export function resetChannels(): void {
	registry.clear();
}
