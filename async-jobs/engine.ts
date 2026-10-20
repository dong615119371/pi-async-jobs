/**
 * The async job engine.
 *
 * A job is started, returns its id immediately, and reports its result later. That
 * is the whole point: the model should not sit idle while a long command runs.
 *
 * Lifecycle of one job:
 *   start()  -> record persisted, slot acquired (or queued), process spawned
 *   ...      -> stdout/stderr stream into <id>.output, and into a bounded tail
 *   exit     -> state becomes terminal, record rewritten, notification delivered
 *
 * Concurrency is capped because every job is a real process. Excess jobs wait in a
 * queue and start as slots free up; they are visible as `running` from the moment
 * they are accepted, because the model has already been told they exist.
 *
 * Kill semantics: cancelling means (1) marking intent, (2) killing the whole process
 * tree, (3) awaiting actual settlement. Without step 3 the notification would race
 * the user - the reference project guards this with a publication gate, and the
 * equivalent here is awaiting the run promise before deciding what to report.
 *
 * Shutdown: Pi fires `session_shutdown` with reasons quit/reload/new/resume/fork. All
 * of them leave our child processes orphaned, so all of them trigger cleanup. The
 * cleanup is idempotent because more than one can arrive.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import { randomInt } from "node:crypto";
import { existsSync as fsExistsSync, openSync, writeSync, closeSync } from "node:fs";
import { killProcessTree, isProcessAlive } from "./process.ts";
import { StreamDecoder } from "./encoding.ts";
import type { JobRecord, JobState, DeliveryTarget, StartProcessOptions, JobHandle, ShellSpec, ShellResolver } from "./types.ts";
import type { JobStore } from "./store.ts";

/**
 * How many jobs may run at once.
 *
 * Each job is a real process with real memory, so this is a safety valve rather than
 * a target: it was raised from 4 to 7 at the user's request. Jobs beyond the cap wait
 * in a queue and start automatically, so raising it does not risk rejecting work - it
 * only changes how many run concurrently.
 */
const MAX_CONCURRENT = 7;
const MAX_TRACKED = 40;
/**
 * Largest delay `setTimeout` accepts (a signed 32-bit millisecond count).
 *
 * Above this Node overflows and silently sets the delay to ONE millisecond, which would turn
 * every bounded wait into an instant timeout. Clamping keeps a silly config value from
 * quietly inverting the behaviour it was meant to lengthen.
 */
const MAX_TIMER_MS = 2_147_483_647;
/**
 * How many finished jobs to keep on disk.
 *
 * Low enough that the directory stays small (a record is ~2 KB and its output is
 * capped by TAIL_BYTES, so 100 jobs is under 2 MB), high enough that a day of
 * normal use does not evict the job you were about to look up. At 25 a single
 * burst of concurrent work could clear the morning's history on its own.
 *
 * `listAll()` sorts newest first, so what survives is the recent end.
 */
const MAX_RETAINED = 100;
const RETENTION_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_SECONDS = 30 * 60;
const TAIL_BYTES = 16 * 1024;
const NOTIFY_PREVIEW_CHARS = 1500;

interface LiveJob {
	record: JobRecord;
	child?: ChildProcess;
	/** Resolves once the process has fully settled, however it ended. */
	settled: Promise<void>;
	resolveSettled: () => void;
	/** Set when the user or shutdown asked for termination. */
	killRequested: boolean;
	killReason?: string;
	/** Called once when this job settles, in place of the global notifiers. */
	onSettle?: (record: JobRecord) => void;
	/**
	 * True when the result has already reached the model by another route - a grace run
	 * that finished inline returns its output as the tool result, so the completion
	 * notification would be a duplicate.
	 */
	selfDelivered?: boolean;
	/** Decoders held open for the lifetime of the stream, flushed on close. */
	decoders?: StreamDecoder[];
	/** Bounded in-memory tail, mirrored to the output file. */
	tail: string;
	outputFd?: number;
	timeoutTimer?: NodeJS.Timeout;
	/** True once the terminal notification has been delivered. */
	delivered: boolean;
}

export interface EngineOptions {
	store: JobStore;
	target: DeliveryTarget;
	/**
	 * Resolve the shell for a job. Injected rather than imported so this module has no
	 * dependency on the Pi package and can be exercised directly by the test suites.
	 * Defaults to a portable fallback when omitted.
	 */
	resolveShell?: ShellResolver;
	/** Injected for tests. */
	now?: () => number;
}

export class JobEngine {
	private readonly jobs = new Map<string, LiveJob>();
	private readonly queue: Array<{ id: string; opts: StartProcessOptions }> = [];
	/**
	 * Ids that currently occupy a concurrency slot.
	 *
	 * This cannot be derived from `record.state`: a queued job is also `running` from
	 * the model's point of view (it has been told the job exists), so counting state
	 * would count queued jobs as active and the cap would never admit them - measured
	 * as a deadlock where 7 jobs were accepted, 4 ran, and the queue never drained.
	 */
	private readonly slots = new Set<string>();
	private readonly store: JobStore;
	private readonly target: DeliveryTarget;
	private readonly now: () => number;
	private readonly resolveShell: ShellResolver;
	private shuttingDown = false;
	private shutdownDone = false;
	/** Recovery report from the previous session, surfaced once on session start. */
	private recovered: JobRecord[] = [];
	/**
	 * This session's short tag, and how many background jobs it has started.
	 *
	 * Ids are `<tag>-<n>` rather than a random blob so that "the 3rd job of this
	 * session" is a thing you can say. The tag is reused for every job in the
	 * session, so two sessions running at once cannot produce the same id - their
	 * counters each start at 1 but the tags differ.
	 *
	 * Chosen lazily: the engine is constructed before `recover()` has looked at
	 * disk, and the tag must not collide with a tag already in use there.
	 */
	private sessionTag: string | null = null;
	private sessionSeq = 0;

	constructor(options: EngineOptions) {
		this.store = options.store;
		this.target = options.target;
		this.now = options.now ?? (() => Date.now());
		this.resolveShell = options.resolveShell ?? defaultShellResolver;
	}

	// ---------------------------------------------------------------- lifecycle

	/**
	 * Scan for jobs that were still running when the previous session ended.
	 *
	 * They cannot be alive any more (their parent is us, and we just started), so
	 * they are marked interrupted and reported - better a truthful "we do not know
	 * how this ended" than a silent disappearance.
	 */
	/**
	 * This session's tag: four base-36 characters, re-rolled until it does not
	 * collide with the tag of any job currently on disk.
	 *
	 * Collision here is the one that matters - a fresh session starting at seq 1
	 * with a tag already in use would hand out an id that names an existing job.
	 * Inside a session there is no collision at all, because the counter only
	 * goes up.
	 *
	 * 36^4 = 1.68M tags against at most MAX_RETAINED live jobs makes a re-roll~ 
	 * vanishingly rare, but picking without checking would make collision possible
	 * rather than improbable, and the failure is silent data loss.
	 *
	 * Upper-case only. This becomes a filename, and Windows does not distinguish
	 * `K3M7` from `k3m7` - two sessions whose tags differ only in case would write
	 * to the same file. Lower-case would work too; one case, never both.
	 */
	private tag(): string {
		if (this.sessionTag !== null) return this.sessionTag;
		const taken = new Set<string>();
		for (const record of this.store.listAll()) {
			const dash = record.id.indexOf("-");
			if (dash > 0) taken.add(record.id.slice(0, dash));
		}
		const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
		let candidate: string;
		do {
			candidate = Array.from({ length: 4 }, () => ALPHABET[randomInt(0, ALPHABET.length)]!).join("");
		} while (taken.has(candidate));
		this.sessionTag = candidate;
		return candidate;
	}

	/** Next job id: `<tag>-<n>`, counting this session's background jobs. */
	private nextId(): string {
		return `${this.tag()}-${++this.sessionSeq}`;
	}

	recover(): JobRecord[] {
		this.store.init();
		const stale: JobRecord[] = [];
		for (const record of this.store.listAll()) {
			if (record.state !== "running") continue;
			record.state = "failed";
			record.error = "interrupted: the session that started this job ended before it finished";
			record.recovered = true;
			record.finishedAt = record.finishedAt ?? this.now();
			this.store.write(record);
			stale.push(record);
		}
		this.recovered = stale;
		this.store.prune(MAX_RETAINED, RETENTION_MS);
		return stale;
	}

	/** Records recovered at startup, so the caller can mention them. */
	takeRecovered(): JobRecord[] {
		const out = this.recovered;
		this.recovered = [];
		return out;
	}

	activeCount(): number {
		return this.slots.size;
	}

	queuedCount(): number {
		return this.queue.length;
	}

	/**
	 * Ids of jobs waiting for a free slot.
	 *
	 * These already read as `running` because their record was created up front, so a
	 * display that only looks at `state` would present waiting jobs as if they were
	 * executing - and count them twice, once as running and once as queued.
	 */
	waitingIds(): Set<string> {
		return new Set(this.queue.map((entry) => entry.id));
	}

	// ------------------------------------------------------------------- start

	/**
	 * Run a command with a grace period: wait up to `graceMs` for it to finish, and if
	 * it is still running, keep it going in the background instead of making the caller
	 * keep waiting.
	 *
	 * This is the mechanism that makes an async mode non-intrusive. A blanket "every
	 * command runs in the background" pushes trivial commands (`ls`, `git status`) into
	 * a needless round trip, while a blanket "every command blocks" freezes the model on
	 * anything slow. Racing the process against a deadline picks the right behaviour per
	 * command without anyone having to guess which is which.
	 *
	 * Returns as soon as the race is decided:
	 *   { outcome: "completed" } - finished inside the grace period; the record is terminal
	 *   { outcome: "adopted" }   - still running; it is now an ordinary background job
	 *
	 * The process is spawned here rather than handed over later, so adoption is not a
	 * handoff at all: only the *reporting* changes. Measured across 12 boundary runs
	 * (process 800-1240ms, grace 1000ms) with no lost output or exit code.
	 */
	async runWithGrace(options: StartProcessOptions, graceMs: number): Promise<{ id: string; outcome: "completed" | "adopted" }> {
		if (this.shuttingDown) {
			throw new Error("Cannot start a job while the session is shutting down.");
		}
		const command = options.command.trim();
		if (command.length === 0) throw new Error("command must not be empty.");

		const id = this.nextId();
		const record: JobRecord = {
			id,
			name: (options.name ?? options.label ?? command).slice(0, 120),
			kind: options.kind ?? "process",
			channel: options.channel ?? "generic",
			state: "running",
			startedAt: this.now(),
			summary: command.slice(0, 400),
			meta: {
				timeoutSeconds: options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
				triggerOnCompletion: options.triggerOnCompletion ?? true,
				graceMs,
			},
			// Optimistic: a grace run is NOT yet a background job. Set at creation rather
			// than after the race, because a fast command finishes and reaches its
			// observers before the race resolves - deciding later would miss exactly those.
			isBackgroundJob: false,
		};

		let resolveSettled!: () => void;
		const settled = new Promise<void>((resolve) => {
			resolveSettled = resolve;
		});

		const live: LiveJob = {
			record,
			settled,
			resolveSettled,
			killRequested: false,
			tail: "",
			delivered: false,
			onSettle: options.onSettle,
			// Set BEFORE spawning, not after the race resolves.
			//
			// The caller always reports a completed grace run inline, so the completion
			// notification is never wanted for it. Setting this after the race was a real
			// race: a fast command (echo, milliseconds) finished before the flag was set,
			// finish() ran the notifier, and the model got the same output twice.
			selfDelivered: true,
		};
		this.jobs.set(id, live);
		this.store.write(record);

		// No start notification yet. The display is meant to answer "what is running in the
		// background", and a command that finishes inside the grace period never becomes a
		// background job at all - announcing it drew a row that vanished again in
		// milliseconds. Measured: every ordinary command made the panel flicker for ~0.0s,
		// which reads as a glitch rather than information. The announcement happens below,
		// only if the job is actually adopted.

		// A grace run always gets a slot: it was admitted by the caller, and refusing it
		// would turn "this might be slow" into a hard failure. If every slot is busy the
		// cap is transiently exceeded, which is preferable to blocking the turn.
		this.slots.add(id);
		this.spawnForJob(live, options);

		const decided = await this.raceWithDeadline(settled, Math.max(0, graceMs)).then((won) =>
			won ? ("completed" as const) : ("adopted" as const),
		);

		if (decided === "completed") {
			return { id, outcome: "completed" };
		}
		// Adopted: the result has NOT been handed back inline, so its completion must be
		// announced. Clearing the flag here is what distinguishes the two outcomes.
		live.selfDelivered = false;
		// Adopted -> it is a real background job from now on.
		live.record.isBackgroundJob = true;

		// Only now is this actually a background job, so only now does it belong on screen.
		// Firing at spawn time instead would flash a row for every `ls`. The record keeps
		// its original start time, so the elapsed column still reads ~20s on arrival.
		this.notifyStarted(live.record);
		// Still running: it stays a normal job. Nothing to transfer - the process, its
		// output stream and its timers were already owned by this engine.
		return { id, outcome: "adopted" };
	}

	/**
	 * Accept a job. Returns immediately - the job runs in the background.
	 * Throws only for input that cannot be valid, never for runtime failure.
	 */
	startProcess(options: StartProcessOptions): JobHandle {
		if (this.shuttingDown) {
			throw new Error("Cannot start a job while the session is shutting down.");
		}
		const command = options.command.trim();
		if (command.length === 0) throw new Error("command must not be empty.");

		const id = this.nextId();
		const record: JobRecord = {
			id,
			name: (options.name ?? options.label ?? command).slice(0, 120),
			kind: options.kind ?? "process",
			channel: options.channel ?? "generic",
			state: "running",
			startedAt: this.now(),
			summary: command.slice(0, 400),
			meta: {
				timeoutSeconds: options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
				triggerOnCompletion: options.triggerOnCompletion ?? true,
			},
			// A `mode: "background"` command is a background job from its first millisecond.
			isBackgroundJob: true,
		};

		let resolveSettled!: () => void;
		const settled = new Promise<void>((resolve) => {
			resolveSettled = resolve;
		});

		const live: LiveJob = {
			record,
			settled,
			resolveSettled,
			killRequested: false,
			tail: "",
			delivered: false,
			onSettle: options.onSettle,
		};
		this.jobs.set(id, live);
		this.store.write(record);
		this.evict();

		// Announce before launching: the display must show a job from the moment it exists,
		// including while it waits for a slot. Firing after launch would miss fast jobs and
		// leave a gap where work is running but nothing is on screen.
		this.notifyStarted(record);

		if (this.slots.size < MAX_CONCURRENT) {
			this.launch(id, live, options);
		} else {
			this.queue.push({ id, opts: options });
		}

		return { id, name: record.name };
	}

	private launch(id: string, live: LiveJob, options: StartProcessOptions): void {
		this.slots.add(id);
		this.spawnForJob(live, options);
	}

	/**
	 * Spawn the process for a job and wire up every handler.
	 *
	 * Separated from `launch` so the grace-period path can use the same wiring: a job
	 * that starts synchronously and one that becomes a background job must behave
	 * identically once the process exists.
	 */
	private spawnForJob(live: LiveJob, options: StartProcessOptions): void {
		const id = live.record.id;
		// Resolve the shell the same way Pi does.
		//
		// Writing bare `bash` here was a real defect: in a background process the PATH
		// ordering differs, so "bash" resolved to the Windows App Execution Alias, which
		// forwards to wsl.exe - and with no WSL installed every job failed instantly with
		// "Windows Subsystem for Linux not found". Pi's own resolver checks known Git Bash
		// locations first and fails loudly rather than silently degrading.
		let shell: ShellSpec;
		try {
			shell = this.resolveShell(options.shell);
		} catch (error) {
			this.finish(live, "failed", {
				error: `no usable shell: ${error instanceof Error ? error.message : String(error)}`,
			});
			return;
		}

		// Some shells (notably the legacy WSL bash) take the command on stdin rather than
		// as an argument. Honouring this is what keeps behaviour identical to Pi's.
		//
		// A long command goes the same way even when the shell does not ask for it. Measured:
		// Git Bash's `bash -c` accepts 8182 bytes and rejects 8187, and a delegate's task is
		// base64-expanded well past that. Sending the command on argv above the limit fails
		// with a misleading `unexpected EOF while looking for matching '"'` - bash is quoting
		// a string that was truncated before it ever arrived. Dropping the `-c` flag makes the
		// shell read a script from stdin instead, which has no such ceiling.
		const MAX_ARGV_COMMAND_BYTES = 7000;
		let viaStdin = shell.commandTransport === "stdin";
		let spawnArgs: string[];
		if (viaStdin) {
			spawnArgs = shell.args;
		} else if (options.command.length > MAX_ARGV_COMMAND_BYTES) {
			viaStdin = true;
			spawnArgs = shell.args.filter((a) => a !== "-c");
		} else {
			spawnArgs = [...shell.args, options.command];
		}

		let child: ChildProcess;
		try {
			child = spawn(shell.shell, spawnArgs, {
				shell: false,
				windowsHide: true,
				stdio: [viaStdin ? "pipe" : "ignore", "pipe", "pipe"],
				env: buildShellEnv(shell.binDir),
			});
			if (viaStdin) {
				child.stdin?.on("error", () => {
					/* the child may exit before reading; ignore */
				});
				child.stdin?.end(options.command);
			}
		} catch (error) {
			this.finish(live, "failed", {
				error: `failed to spawn: ${error instanceof Error ? error.message : String(error)}`,
			});
			return;
		}

		live.child = child;
		live.record.pid = child.pid;
		this.store.write(live.record);

		try {
			live.outputFd = openSync(this.store.outputPathFor(id), "a");
		} catch {
			live.outputFd = undefined;
		}

		// Decode with an encoder-aware reader, not a blind UTF-8 cast.
		//
		// Measured: `wsl.exe` emits UTF-16LE, so decoding its output as UTF-8 turned a
		// readable Chinese error into "*g?[??(u?N ..." - which was misdiagnosed as a shell
		// fault at the time. A stream is decoded with one held-open decoder so a
		// multi-byte character split across two chunks is not mangled either.
		const stdoutDecoder = new StreamDecoder();
		const stderrDecoder = new StreamDecoder();
		live.decoders = [stdoutDecoder, stderrDecoder];
		child.stdout?.on("data", (chunk: Buffer) => {
			this.appendOutput(live, stdoutDecoder.push(chunk));
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			this.appendOutput(live, stderrDecoder.push(chunk));
		});

		const timeoutSeconds = options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
		if (timeoutSeconds > 0) {
			live.timeoutTimer = setTimeout(
				() => {
					live.record.timedOut = true;
					live.killRequested = true;
					live.killReason = `timed out after ${timeoutSeconds}s`;
					void this.terminate(live);
				},
				// Same overflow trap as the grace deadline: an explicit `timeout` can be any
				// number the caller types, and anything past ~24 days would land as 1ms and
				// kill a job instantly instead of never.
				Math.min(Math.max(0, timeoutSeconds * 1000), MAX_TIMER_MS),
			);
		}

		child.on("error", (error) => {
			this.finish(live, "failed", { error: `process error: ${error.message}` });
		});
		child.on("close", (code, signal) => {
			// Flush anything the decoders were holding mid-character.
			this.flushDecoders(live);
			// `killRequested` means the engine asked it to stop. That is not the same as the
			// user asking: the kill limit fires through the same flag, and a timed-out job is
			// exactly the case the caller must hear about. Only `kill()` - the user's own
			// request - sets `killedByUser`, and that is the one that suppresses delivery.
			const wasKilled = live.killRequested;
			const state: JobState = wasKilled ? "killed" : code === 0 ? "done" : "failed";
			this.finish(live, state, {
				exitCode: code ?? undefined,
				error: wasKilled
					? live.record.timedOut
						? `timed out after ${String(live.record.meta?.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS)}s`
						: (live.killReason ?? `terminated by ${signal ?? "request"}`)
					: code === 0
						? undefined
						: `exited with code ${String(code)}`,
			});
		});
	}

	private appendOutput(live: LiveJob, text: string): void {
		if (live.outputFd !== undefined) {
			try {
				writeSync(live.outputFd, text);
			} catch {
				/* output file became unwritable; the tail still has it */
			}
		}
		live.tail += text;
		if (live.tail.length > TAIL_BYTES) {
			live.tail = live.tail.slice(live.tail.length - TAIL_BYTES);
		}
	}

	// ------------------------------------------------------------------ finish

	private finish(live: LiveJob, state: JobState, extra: Partial<JobRecord>): void {
		if (live.record.state !== "running") return;
		this.slots.delete(live.record.id);
		if (live.timeoutTimer) clearTimeout(live.timeoutTimer);
		if (live.outputFd !== undefined) {
			try {
				closeSync(live.outputFd);
			} catch {
				/* already closed */
			}
			live.outputFd = undefined;
		}

		live.record.state = state;
		live.record.finishedAt = this.now();
		live.record.output = live.tail.trim() || undefined;
		Object.assign(live.record, extra);

		// A command that finished inside the grace period was never a background job: its
		// result went back inline, the caller already has it, and nothing will ever look it
		// up by id. Keeping its record and output file on disk would leave one pair of
		// files behind for every ordinary short command - hundreds per session, all of them
		// unfindable from the UI and indistinguishable from real jobs in a directory listing.
		//
		// The record was written to disk at creation (needed - a fast command can settle
		// before the grace race resolves), so finishing means UNDOING that write, not just
		// skipping one. The journal has always filtered these out (journal.ts toJournalEntry);
		// this brings the working-state store in line with it.
		if (live.record.isBackgroundJob === false) {
			this.store.remove(live.record.id);
		} else {
			this.store.write(live.record);
		}

		live.resolveSettled();
		this.pump();
		this.evict();

		// Observers are told about EVERY terminal job, unlike the delivery handlers below.
		// The display depends on this: a command that finishes inside the grace period has
		// its result handed back inline, which suppresses delivery - and if the display
		// refresh rode along with delivery, its row would stay on screen forever.
		// Two separate channels, because "someone must see the result" and "someone must
		// notice the job ended" are different questions.
		this.notifyTerminal(live.record);

		// A per-job callback takes precedence over the global notifiers: it lets a caller
		// deliver its own way (for instance as a steering message) without the generic
		// wake-up firing too, which would report the same job twice.
		if (live.selfDelivered) {
			// Already reported inline; nothing to announce.
		} else if (live.onSettle) {
			try {
				live.onSettle(live.record);
			} catch {
				/* a bad callback must not break the engine */
			}
		} else {
			this.notifyFinish(live.record);
		}
	}

	/** Start the next queued job if a slot is free. */
	private pump(): void {
		while (this.slots.size < MAX_CONCURRENT && this.queue.length > 0) {
			const next = this.queue.shift();
			if (!next) return;
			const live = this.jobs.get(next.id);
			if (!live || live.record.state !== "running") continue;
			if (this.shuttingDown) {
				live.record.state = "killed";
				live.record.finishedAt = this.now();
				live.record.error = "session shut down before this job started";
				this.store.write(live.record);
				live.resolveSettled();
				continue;
			}
			this.launch(next.id, live, next.opts);
		}
	}

	/** Drop the oldest finished jobs once too many are tracked. */
	private evict(): void {
		if (this.jobs.size <= MAX_TRACKED) return;
		const finished: Array<[string, LiveJob]> = [];
		for (const entry of this.jobs) {
			if (entry[1].record.state !== "running") finished.push(entry);
		}
		finished.sort((a, b) => (a[1].record.finishedAt ?? 0) - (b[1].record.finishedAt ?? 0));
		for (const [id] of finished) {
			if (this.jobs.size <= MAX_TRACKED) break;
			this.jobs.delete(id);
		}
	}

	// --------------------------------------------------------------- completion

	/**
	 * Turn a terminal job into a message the model can act on.
	 * Called by the owner of the job (the extension) so it can format its own channel.
	 */
	async deliver(
		job: JobRecord,
		format: (record: JobRecord) => string,
		triggerTurn: boolean,
		mode: "steer" | "followUp" = "steer",
	): Promise<boolean> {
		const live = this.jobs.get(job.id);
		if (live?.delivered) return false;
		if (live) live.delivered = true;

		const record = live?.record ?? job;
		if (record.killedByUser && record.state === "killed") {
			// An intentional kill is not news; the user already knows.
			return false;
		}

		try {
			this.target.sendMessage(
				{
					customType: "async-job",
					content: format(record),
					display: true,
					details: {
						id: record.id,
						state: record.state,
						channel: record.channel,
						finishedAt: record.finishedAt,
					},
				},
				triggerTurn ? { triggerTurn: true, deliverAs: mode } : {},
			);
			this.store.write(record);
			return true;
		} catch {
			// The session may be tearing down; the record on disk is the fallback.
			return false;
		}
	}

	/** Attach a notifier: called once per job as it reaches a terminal state. */
	onFinished(handler: (record: JobRecord) => void): void {
		this.finishHandlers.push(handler);
	}

	/** Called as soon as a job exists, before it starts running. */
	onStarted(handler: (record: JobRecord) => void): void {
		this.startHandlers.push(handler);
	}

	private notifyStarted(record: JobRecord): void {
		for (const handler of this.startHandlers) {
			try {
				handler(record);
			} catch {
				/* a bad observer must not prevent the job from running */
			}
		}
	}

	private readonly startHandlers: Array<(record: JobRecord) => void> = [];

	private readonly finishHandlers: Array<(record: JobRecord) => void> = [];

	private readonly terminalHandlers: Array<(record: JobRecord) => void> = [];

	/**
	 * Observe every terminal job, whether or not its result is delivered to the model.
	 *
	 * Distinct from `onFinished`, which is the delivery channel and is skipped when a
	 * result was already handed back inline.
	 */
	onTerminal(handler: (record: JobRecord) => void): void {
		this.terminalHandlers.push(handler);
	}

	private notifyTerminal(record: JobRecord): void {
		for (const handler of this.terminalHandlers) {
			try {
				handler(record);
			} catch {
				/* an observer must not break the engine */
			}
		}
	}

	/** Invoked by finish() to fan out to notifiers, after the record is durable. */
	private notifyFinish(record: JobRecord): void {
		for (const handler of this.finishHandlers) {
			try {
				handler(record);
			} catch {
				/* a bad notifier must not break the engine */
			}
		}
	}

	// -------------------------------------------------------------------- kill

	/**
	 * Kill a job and wait until it actually settled.
	 *
	 * Returns false when the id is unknown or the job already finished.
	 */
	async kill(id: string, reason = "killed on request"): Promise<{ ok: boolean; message: string }> {
		const live = this.jobs.get(id);
		if (!live) return { ok: false, message: `Unknown job: ${id}` };
		if (live.record.state !== "running") {
			return { ok: false, message: `Job ${id} is already ${live.record.state}.` };
		}

		// Still queued: never spawned, so just remove it.
		const queueIndex = this.queue.findIndex((entry) => entry.id === id);
		if (queueIndex >= 0 && !live.child) {
			this.queue.splice(queueIndex, 1);
			live.record.state = "killed";
			live.record.finishedAt = this.now();
			live.record.error = reason;
			live.record.killedByUser = true;
			this.store.write(live.record);
			live.resolveSettled();
			this.evict();
			return { ok: true, message: `Job ${id} was still queued and has been cancelled.` };
		}

		live.killRequested = true;
		live.killReason = reason;
		live.record.killedByUser = true;
		await this.terminate(live);
		return { ok: true, message: `Job ${id} terminated (${reason}).` };
	}

	/** Send the tree kill, then wait for the process to be gone. */
	private async terminate(live: LiveJob): Promise<void> {
		const pid = live.child?.pid ?? live.record.pid;
		if (pid !== undefined) {
			await killProcessTree(pid, () => isProcessAlive(pid));
		}
		// The exit handler normally settles this. But `close` is not guaranteed to
		// arrive - a detached tree, a process killed before its stdio ever opened, or a
		// zombie can all skip it. Measured: after killing a job whose child had spawned
		// a grandchild, the state stayed `running` even though the process was gone.
		// So settle it here rather than trust the event.
		await this.raceWithDeadline(live.settled, 2000);
		if (live.record.state === "running") {
			// `close` never arrived, so nothing flushed the decoders. Without this the last
			// few buffered bytes (a partial character, up to one buffer's worth) would be
			// silently dropped - the same loss the `close` handler exists to prevent.
			this.flushDecoders(live);
			this.finish(live, "killed", {
				error: live.record.timedOut
					? `timed out after ${String(live.record.meta?.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS)}s`
					: (live.killReason ?? "terminated"),
			});
		}
	}

	// ---------------------------------------------------------------- shutdown

	/**
	 * Kill every running job. Idempotent: `session_shutdown` can arrive more than
	 * once (for example `reload` followed by `quit`).
	 */
	async shutdownAll(reason: string): Promise<{ killed: number; leaked: number }> {
		if (this.shutdownDone) return { killed: 0, leaked: 0 };
		this.shuttingDown = true;
		this.shutdownDone = true;

		// Anything still queued never started.
		for (const entry of this.queue) {
			const live = this.jobs.get(entry.id);
			if (live && live.record.state === "running") {
				live.record.state = "killed";
				live.record.finishedAt = this.now();
				live.record.error = `cancelled during ${reason}`;
				this.store.write(live.record);
				live.resolveSettled();
			}
		}
		this.queue.length = 0;

		const running = [...this.jobs.values()].filter((job) => job.record.state === "running");
		let killed = 0;
		let leaked = 0;

		await Promise.all(
			running.map(async (live) => {
				const pid = live.child?.pid ?? live.record.pid;
				live.killRequested = true;
				live.killReason = `session ${reason}`;
				if (pid !== undefined) {
					const result = await killProcessTree(pid, () => isProcessAlive(pid));
					if (result.leaked) leaked++;
				}
				if (live.record.state === "running") {
					this.finish(live, "killed", { error: `session ${reason}` });
				}
				killed++;
			}),
		);

		return { killed, leaked };
	}

	// ------------------------------------------------------------------- query

	get(id: string): JobRecord | null {
		const live = this.jobs.get(id);
		if (live) return live.record;
		return null;
	}

	/** Push out anything a decoder is holding mid-character. */
	private flushDecoders(live: LiveJob): void {
		for (const decoder of live.decoders ?? []) {
			const tail = decoder.flush();
			if (tail) this.appendOutput(live, tail);
		}
	}

	/**
	 * Resolve true when `work` settles first, false when `timeoutMs` elapses first.
	 *
	 * Every bounded wait in this engine goes through here, because the obvious version -
	 * `Promise.race([work, new Promise(r => setTimeout(r, ms))])` - leaks the timer. Losing
	 * the race does NOT cancel a setTimeout, so the losing timer keeps the event loop alive
	 * for its FULL duration. Measured: a race that resolved at 0ms kept a Node process
	 * running until 3001ms. With a grace period as long as 119s and a command that finishes
	 * in one, that is nearly two minutes of a pinned backend per call, plus one live timer
	 * per call in a long-running session.
	 */
	private async raceWithDeadline(work: Promise<unknown>, timeoutMs: number): Promise<boolean> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		// setTimeout stores its delay in a signed 32-bit int. Anything larger OVERFLOWS and Node
		// silently rewrites it to 1ms ("Timeout duration was set to 1"), so a huge configured
		// grace period would make every command adopt instantly instead of waiting. Clamping is
		// the honest fix: a deadline ~24 days out is indistinguishable from "no deadline".
		const delay = Math.min(Math.max(0, timeoutMs), MAX_TIMER_MS);
		const deadline = new Promise<"timeout">((resolve) => {
			timer = setTimeout(() => resolve("timeout"), delay);
		});
		try {
			const winner = await Promise.race([
				work.then(() => "work" as const),
				deadline,
			]);
			return winner === "work";
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	}

	/** Resolve an id, accepting an unambiguous prefix as a convenience. */
	resolve(idOrPrefix: string): { record: JobRecord | null; error?: string } {
		if (this.jobs.has(idOrPrefix)) return { record: this.jobs.get(idOrPrefix)!.record };
		const matches = [...this.jobs.keys()].filter((id) => id.startsWith(idOrPrefix));
		if (matches.length === 0) {
			// Fall back to disk: the job may predate this session.
			const stored = this.store.read(idOrPrefix);
			return stored ? { record: stored } : { record: null, error: `Unknown job: ${idOrPrefix}` };
		}
		if (matches.length > 1) {
			return { record: null, error: `Ambiguous id "${idOrPrefix}": matches ${matches.join(", ")}` };
		}
		return { record: this.jobs.get(matches[0])!.record };
	}

	all(): JobRecord[] {
		return [...this.jobs.values()].map((job) => job.record);
	}

	/**
	 * Read a job's output.
	 *
	 * The output FILE is the source of truth, because the in-memory tail is capped and
	 * a finished job may have produced megabytes. Reading memory first meant `job_logs`
	 * could never return more than the tail cap even when the file held everything.
	 * Memory is only a fallback for the window before the file is readable.
	 */
	logs(id: string, maxBytes = 4000): { text: string; truncated: boolean; totalBytes: number } {
		const fromFile = this.store.tailOutput(id, maxBytes);
		if (fromFile.totalBytes > 0) return fromFile;

		const fromMemory = this.jobs.get(id);
		if (fromMemory && fromMemory.tail.length > 0) {
			const text = fromMemory.tail;
			const bytes = Buffer.byteLength(text, "utf8");
			if (bytes <= maxBytes) return { text, truncated: false, totalBytes: bytes };
			let cut = text.slice(text.length - maxBytes);
			while (Buffer.byteLength(cut, "utf8") > maxBytes) cut = cut.slice(1);
			return { text: cut, truncated: true, totalBytes: bytes };
		}
		return { text: "", truncated: false, totalBytes: 0 };
	}

}

/**
 * Pick a shell for job execution.
 *
 * On Windows prefer Git Bash when it is on PATH (that is what Pi's own bash tool
 * uses), otherwise fall back to `cmd.exe`. Elsewhere, `/bin/sh -c`.
 */
// `resolveShell` was removed: it hard-coded a bare `bash` and broke every background
// job on Windows (see the note in `launch`). Shell resolution now goes through Pi's
// exported `getShellConfig`, so foreground and background behave identically.

/**
 * Environment for a job's shell process.
 *
 * Inherits the current environment and puts Pi's bin directory on PATH so the tools
 * Pi ships (`rg`, `fd`) stay reachable from a background job. Kept local because Pi's
 * equivalent helper is not exported from the package entrypoint.
 */
function buildShellEnv(binDir?: string): NodeJS.ProcessEnv {
	const env = { ...process.env };
	if (!binDir) return env;
	const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
	const current = env[pathKey] ?? "";
	const entries = current.split(path.delimiter).filter(Boolean);
	if (!entries.includes(binDir)) {
		env[pathKey] = [binDir, current].filter(Boolean).join(path.delimiter);
	}
	return env;
}

/**
 * Fallback shell resolution, used when no resolver is injected (tests, or a host that
 * does not provide one).
 *
 * Deliberately does NOT fall back to a bare `bash` on Windows: that name resolves
 * through the App Execution Alias to `wsl.exe`, which fails with "Windows Subsystem
 * for Linux not found" on a machine without WSL. An absolute Git Bash path is tried
 * first, and failure is loud rather than silent.
 */
function defaultShellResolver(explicit?: string): ShellSpec {
	if (explicit) return { shell: explicit, args: ["-c"] };
	if (process.platform === "win32") {
		const candidates = [
			process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Git", "bin", "bash.exe"),
			process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Git", "bin", "bash.exe"),
		].filter((p): p is string => typeof p === "string");
		for (const candidate of candidates) {
			try {
				if (fsExistsSync(candidate)) return { shell: candidate, args: ["-c"] };
			} catch {
				/* try the next candidate */
			}
		}
		throw new Error(
			"No Git Bash found. Install Git for Windows, or set shellPath in settings.json.\n" +
				`Searched: ${candidates.join(", ") || "(no ProgramFiles set)"}`,
		);
	}
	return { shell: "/bin/sh", args: ["-c"] };
}
