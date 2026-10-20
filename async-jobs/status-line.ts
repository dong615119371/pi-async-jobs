/**
 * The background-job display.
 *
 * Why this exists: with jobs running in the background, the user had no way to know
 * they were there. A job could be silently burning CPU, or one could be stuck, and the
 * only clue was that the model seemed to be taking a while. The result is a persistent
 * footer entry plus a list above the editor, both of which disappear on their own when
 * nothing is running.
 *
 * Kept apart from the extension so the formatting can be tested without a Pi session.
 */

import type { JobRecord } from "./types.ts";

/** Marker for a running job. Plain ASCII: a wide or ambiguous glyph would break the
 *  alignment Pi warns about, and this is a display that must never look broken. */
const MARKER = "*";

/** Longest label kept before the tail is dropped. */
const MAX_LABEL = 60;

/** Width of the elapsed-time column, in terminal columns. */
const STATE_COLUMN = 8;

/**
 * Pad to a terminal-column width.
 *
 * A CJK character occupies two columns, so `padEnd` - which counts characters - leaves
 * those rows short and the columns ragged.
 */
function padTo(text: string, columns: number): string {
	let width = 0;
	for (const ch of text) width += isWide(ch) ? 2 : 1;
	return width >= columns ? text : text + " ".repeat(columns - width);
}

/** Whether a character occupies two terminal columns (CJK and fullwidth forms). */
function isWide(ch: string): boolean {
	const code = ch.codePointAt(0) ?? 0;
	return (
		(code >= 0x1100 && code <= 0x115f) ||
		(code >= 0x2e80 && code <= 0xa4cf) ||
		(code >= 0xac00 && code <= 0xd7a3) ||
		(code >= 0xf900 && code <= 0xfaff) ||
		(code >= 0xfe30 && code <= 0xfe6f) ||
		(code >= 0xff00 && code <= 0xff60) ||
		(code >= 0xffe0 && code <= 0xffe6)
	);
}

/** Elapsed time as a compact, always-narrow string: `9s`, `3m12s`, `1h05m`. */
export function formatElapsed(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	if (total < 60) return `${total}s`;
	const minutes = Math.floor(total / 60);
	if (minutes < 60) return `${minutes}m${String(total % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * Collapse a label onto one line.
 *
 * A command can be a multi-line script, and a newline inside a widget line would inject
 * spurious structure into the display, so whitespace runs are flattened first.
 */
export function sanitizeLabel(text: string, max = MAX_LABEL): string {
	const flat = text.replace(/\s+/g, " ").trim();
	if (flat.length <= max) return flat;
	return `${flat.slice(0, max - 1)}…`;
}

/** The footer text: compact enough to sit beside the model name and folder. */
export function formatFooter(running: number, queued: number): string {
	if (running === 0 && queued === 0) return "";
	const parts = [`${running} 个作业运行中`];
	if (queued > 0) parts.push(`${queued} 个排队`);
	return parts.join("，");
}

/**
 * The lines shown above the editor, or an empty array when nothing is in flight.
 *
 * Columns are padded so the eye can scan down `id / elapsed / what it is` without the
 * label wandering. Ids are `<tag>-<n>` - six characters plus however many digits the
 * counter has reached - and elapsed time is padded to six, which together cover every
 * case up to `999h`.
 *
 * `waiting` carries the ids still queued for a slot. They must be marked, not just
 * counted: they are `running` records that have not started, and showing a ticker next
 * to them would claim work is happening that has not begun.
 */
export function buildWidgetLines(jobs: JobRecord[], now: number, waiting?: Set<string>): string[] {
	if (jobs.length === 0) return [];

	const waitingCount = waiting ? jobs.filter((job) => waiting.has(job.id)).length : 0;
	const header = `后台作业 ${jobs.length} 个${waitingCount > 0 ? `（其中 ${waitingCount} 个排队中）` : ""}`;

	const lines = jobs.map((job) => {
		const queued = waiting?.has(job.id) === true;
		const state = queued ? "排队中" : formatElapsed(now - job.startedAt);
		const marker = queued ? "-" : MARKER;
		// Pad by display width, not string length: "排队中" is three characters but six
		// terminal columns, while "28s" is three of each. Padding by `.length` would
		// misalign exactly the row that needs to stand out.
		return `  ${marker} ${job.id}  ${padTo(state, STATE_COLUMN)}  ${sanitizeLabel(job.name)}`;
	});

	return [header, ...lines];
}

/** Serialise for change detection, so identical frames do not churn the terminal. */
export function widgetSignature(lines: string[]): string {
	return lines.join("\n");
}
