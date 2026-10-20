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
 * How much of the output file the fallback will read when `record.output` is empty.
 *
 * Larger than a digest, smaller than the file: this is a last-resort view for a job the
 * framework cannot render properly, so it should show enough to be useful without
 * pushing tens of kilobytes into the model's context.
 */
const TAIL_FOR_FALLBACK = 4000;

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
			const out = renderer.render(record, ctx);
			// Whitespace counts as empty here. A renderer that returns "   " produces a
			// delivery that looks like the job said nothing, which is the same loss as an
			// empty string and the case the fallback exists for.
			if (out.trim().length > 0) return out;
		} catch {
			/* fall through to the plain form rather than lose the result */
		}
	}
	// Outside the try on purpose. A renderer may have left `record.output` in a shape
	// `fallbackRender` cannot read (it is the live record, and a renderer can write to
	// it), so the fallback needs its own guard - otherwise it throws, the exception
	// escapes this function, and the caller's catch swallows the result entirely. That
	// is the one outcome this whole path exists to prevent.
	try {
		return fallbackRender(record, ctx);
	} catch {
		return `[Job ${String(record?.id ?? "?")} ${String(record?.state ?? "?")}]\n(renderer and fallback both failed)`;
	}
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
 *
 * `record.output` is the in-memory tail, capped at `TAIL_BYTES` (16 KB) and absent
 * entirely for a record read back from disk after `recover()`. When it has nothing,
 * read the output file instead - a job that produced 40 KB of real output should not
 * present as "(no output)" just because the fallback is the one rendering it.
 */
function fallbackRender(record: JobRecord, ctx?: ChannelRenderContext): string {
	const head = `[Job ${String(record?.id ?? "?")} ${String(record?.state ?? "?")}]`;
	let body = "";
	try {
		body = typeof record?.output === "string" ? record.output.trim() : "";
	} catch {
		body = "";
	}
	if (body.length === 0 && ctx && typeof record?.id === "string") {
		try {
			const tail = ctx.tailOutput(record.id, TAIL_FOR_FALLBACK);
			body = tail.text.trim();
		} catch {
			body = "";
		}
	}
	if (body.length === 0) body = record?.error ?? "(no output)";
	return `${head}\n${body}`;
}

/** Test hook: drop everything, so one test file cannot leak renderers into the next. */
export function resetChannels(): void {
	registry.clear();
}
