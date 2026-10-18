/**
 * The job journal.
 *
 * An append-only record of every background job that ever ran, kept outside the job
 * store's retention policy. The job records in `~/.pi/agent/async-jobs/*.json` are
 * *working state*: they are pruned by count and age, and `store.remove` deletes them
 * along with their output. That is right for working state and wrong for history - a
 * question like "what did I run an hour ago, and what did it print?" has to survive it.
 *
 * One line per job, JSON, so it stays greppable and machine-readable. Written when the
 * job reaches a terminal state - unconditionally, from `onTerminal`, not from the
 * delivery channel: a command that finishes inside the grace period has its result
 * handed back inline and never reaches `onFinished`, and would otherwise go unrecorded.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { JobRecord } from "./types.ts";

/** How much of the command and output to keep per entry. */
const MAX_COMMAND_CHARS = 2000;
const MAX_OUTPUT_CHARS = 8000;

export interface JournalEntry {
	/** Epoch ms when the job reached a terminal state. */
	at: number;
	id: string;
	state: JobRecord["state"];
	/** The command line, or the job's task. */
	command: string;
	startedAt: number;
	finishedAt?: number;
	/** Wall-clock duration, rounded to seconds. */
	durationSeconds: number;
	exitCode?: number;
	/** Whether the run was cut short by the kill limit or the user. */
	timedOut?: boolean;
	killedByUser?: boolean;
	error?: string;
	/** Tail of the output, with the truncation noted in `outputTruncated`. */
	output: string;
	outputTruncated: boolean;
}

/** Build a journal entry from a finished job. */
/**
 * Build a journal entry from a finished job.
 *
 * Returns null for a job that was never a background job. A command that finished inside
 * the grace period had its result handed back inline: the model already has the answer,
 * and the user never saw it in the job panel, so recording it would fill the history with
 * entries that correspond to nothing anyone can act on.
 *
 * Deliberately keyed on `isBackgroundJob` rather than on elapsed time. "Under 20 seconds" is
 * the common case but not the rule - a command can finish in 3s and still be adopted when
 * the machine stalls, and a `mode: "background"` command is a background job from the start.
 * Records written before the field existed have `undefined` and are kept.
 */
export function toJournalEntry(record: JobRecord): JournalEntry | null {
	if (record.isBackgroundJob === false) return null;

	const rawOutput = record.output ?? "";
	const truncated = rawOutput.length > MAX_OUTPUT_CHARS;
	const command = record.summary ?? record.name;

	return {
		at: Date.now(),
		id: record.id,
		state: record.state,
		command:
			command.length > MAX_COMMAND_CHARS ? `${command.slice(0, MAX_COMMAND_CHARS)}…` : command,
		startedAt: record.startedAt,
		finishedAt: record.finishedAt,
		durationSeconds: record.finishedAt ? Math.round((record.finishedAt - record.startedAt) / 1000) : 0,
		exitCode: record.exitCode,
		...(record.timedOut ? { timedOut: true } : {}),
		...(record.killedByUser ? { killedByUser: true } : {}),
		...(record.error ? { error: record.error } : {}),
		// Keep the END of the output: the last lines are what explain a failure.
		output: truncated ? rawOutput.slice(-MAX_OUTPUT_CHARS) : rawOutput,
		outputTruncated: truncated,
	};
}

export class JobJournal {
	private readonly dir: string;

	constructor(dir: string) {
		this.dir = dir;
	}

	/**
	 * Today's file.
	 *
	 * The date is IN THE NAME rather than inferred from mtime: a file called
	 * `job-history.jsonl` gives no way to tell which day it covers, so retention means
	 * opening files and reasoning about timestamps. With the date up front, cleanup is a
	 * filename pattern that a person can act on by eye.
	 */
	path(date = new Date()): string {
		return path.join(this.dir, `job-history-${todayStamp(date)}.jsonl`);
	}

	/**
	 * Append one entry.
	 *
	 * Returns false when nothing was written, which includes the common case of a job that
	 * never became a background job.
	 *
	 * Never throws: losing history is bad, but breaking the job pipeline because a log
	 * write failed is worse.
	 */
	append(record: JobRecord): boolean {
		const entry = toJournalEntry(record);
		if (entry === null) return false;
		try {
			fs.mkdirSync(this.dir, { recursive: true });
			fs.appendFileSync(this.path(), `${JSON.stringify(entry)}\n`, "utf8");
			// Keep today and yesterday: one day is the useful window, and the extra file is
			// what makes "what did I run just before midnight?" answerable the next morning.
			this.prune(2);
			return true;
		} catch {
			return false;
		}
	}

	/** Delete dated files beyond the newest `keep`, today included. */
	private prune(keep: number): void {
		try {
			for (const file of this.days().slice(keep)) fs.rmSync(file, { force: true });
		} catch {
			/* best effort */
		}
	}

	/** Every dated file, newest first. */
	days(): string[] {
		try {
			return fs
				.readdirSync(this.dir)
				.filter((name) => /^job-history-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
				.sort()
				.reverse()
				.map((name) => path.join(this.dir, name));
		} catch {
			return [];
		}
	}

	/**
	 * Read back the most recent entries, newest last.
	 *
	 * The file is append-only, so the tail is read by scanning backwards from the end
	 * rather than parsing the whole thing - it is expected to grow without bound.
	 */
	tail(count: number): JournalEntry[] {
		const wanted = Math.max(1, count);
		const collected: JournalEntry[] = [];
		// Walk the dated files newest-first until enough entries are gathered. Reading only
		// `path()` (today) was a real defect: `prune(2)` deliberately keeps yesterday so that
		// "what did I run just before midnight?" stays answerable, and the tool description
		// promises lookups from a previous session - but nothing ever opened that second file,
		// so at 00:01 every id from the day before became unanswerable.
		for (const file of this.days()) {
			if (collected.length >= wanted) break;
			try {
				const raw = fs.readFileSync(file, "utf8");
				const lines = raw.split("\n").filter((line) => line.trim().length > 0);
				const parsed = lines
					.slice(-wanted)
					.map((line) => {
						try {
							return JSON.parse(line) as JournalEntry;
						} catch {
							return null;
						}
					})
					.filter((entry): entry is JournalEntry => entry !== null);
				// Newer files go in front, so the final order stays oldest-first.
				collected.unshift(...parsed);
			} catch {
				/* a missing or unreadable day contributes nothing */
			}
		}
		return collected.slice(-wanted);
	}

	/** Total entries across the retained days, for the summary line. */
	count(): number {
		return this.days().reduce((total, file) => {
			try {
				const raw = fs.readFileSync(file, "utf8");
				return total + raw.split("\n").filter((line) => line.trim().length > 0).length;
			} catch {
				return total;
			}
		}, 0);
	}
}

/** Local date as `YYYY-MM-DD`. */
export function todayStamp(date = new Date()): string {
	return (
		`${date.getFullYear()}-` +
		`${String(date.getMonth() + 1).padStart(2, "0")}-` +
		`${String(date.getDate()).padStart(2, "0")}`
	);
}

/**
 * Collapse a command for display.
 *
 * Real commands are often multi-line scripts. Printing one verbatim buried the actual
 * result under a wall of shell, so the first line is kept (it is almost always the
 * meaningful part) with a count of what was elided. `job_logs` has the full text.
 */
export function summarizeCommand(command: string, maxChars = 120): string {
	const lines = command.split("\n");
	const first = (lines[0] ?? "").trim();
	const extra = lines.length - 1;

	let head = first.length > maxChars ? `${first.slice(0, maxChars - 1)}…` : first;
	if (extra > 0) head += `  (+${extra} 行)`;
	return head;
}

/** One entry rendered as readable text, for `job_history` and `/job-history`. */
export function formatJournalEntry(entry: JournalEntry, full = false): string {
	const when = new Date(entry.at);
	const stamp =
		`${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, "0")}-${String(when.getDate()).padStart(2, "0")} ` +
		`${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}:${String(when.getSeconds()).padStart(2, "0")}`;

	const head = `${stamp}  ${entry.id}  ${entry.state}  ${entry.durationSeconds}s`;
	const notes: string[] = [];
	if (entry.exitCode !== undefined) notes.push(`exit ${entry.exitCode}`);
	if (entry.timedOut) notes.push("超时");
	if (entry.killedByUser) notes.push("被杀");
	const note = notes.length > 0 ? `  (${notes.join(", ")})` : "";

	// `full` keeps the whole command; the default collapses it to its first line.
	const command = full ? entry.command : summarizeCommand(entry.command);
	const lines = [`${head}${note}`, `  $ ${command}`];
	if (entry.error) lines.push(`  error: ${entry.error}`);

	if (entry.output.trim().length > 0) {
		const body = full ? entry.output : entry.output.slice(0, 600);
		const clipped = !full && entry.output.length > 600;
		lines.push(
			body
				.split("\n")
				.map((line) => `  │ ${line}`)
				.join("\n"),
		);
		if (clipped) lines.push("  │ … (use full: true to see all)");
		if (entry.outputTruncated && full) lines.push("  │ … (entry was truncated when recorded)");
	}
	return lines.join("\n");
}
