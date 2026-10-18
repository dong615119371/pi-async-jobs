/**
 * Shared types for the async job framework.
 *
 * This file is the framework's public surface. It must not name a specific channel:
 * `generic` is the built-in one, and any other channel is registered at runtime by the
 * extension that owns it (see {@link ChannelRenderer}). That is what keeps this package
 * free of any knowledge about a specific channel - the earlier `"somechannel"` member of a
 * closed union was a compile-time dependency on a different extension's vocabulary.
 */

export type JobState = "running" | "done" | "failed" | "killed";

/**
 * What sort of job this is.
 *
 * `"delegate"` is an EXTENSION POINT with no producer today: the engine only ever
 * creates `"process"`. A plugin that hands work to an outside agent can tag its jobs
 * `"delegate"` so a renderer can tell them apart. Deliberately kept - removing it would
 * mean every such plugin has to fork this type.
 */
export type JobKind = "process" | "delegate";

/**
 * Which delivery adapter turns a finished job into model context.
 *
 * Open by design: `generic` ships with the framework, anything else is whatever a
 * registered channel named itself. A closed union here would force every future channel
 * into this file.
 */
export type JobChannel = string;

export interface JobRecord {
	id: string;
	name: string;
	kind: JobKind;
	channel: JobChannel;
	state: JobState;
	/** Epoch ms. */
	startedAt: number;
	finishedAt?: number;
	/** Short human description: the command line, or the job's task. */
	summary: string;
	/** Extra fields a channel needs to render its result. */
	meta?: Record<string, unknown>;
	/** Model-facing result text once the job is terminal. */
	output?: string;
	exitCode?: number;
	pid?: number;
	/**
	 * Channel-specific statistics. Lives in a bag rather than as named fields so the
	 * framework never learns one channel's vocabulary.
	 *
	 * EXTENSION POINT: no built-in code writes or reads this today. It exists so a
	 * registered channel renderer can record facts on the record (a session id to
	 * continue a conversation, a tool-call count for the digest) and have them persist
	 * through `renderAndPersist`. Without this bag a channel would need named fields on
	 * JobRecord, which is what leaked one channel's vocabulary into the framework.
	 */
	stats?: Record<string, number | string>;
	error?: string;
	/** Set when the user explicitly killed the job, to suppress the completion notice. */
	killedByUser?: boolean;
	/** True when this record was recovered from disk rather than run in this session. */
	recovered?: boolean;
	timedOut?: boolean;
	/**
	 * Whether this is a REAL background job - one the user sees in the job panel and can
	 * look up later.
	 *
	 * Three states, and the difference matters:
	 *   true      - a background job (mode:"background", or a grace run that was adopted)
	 *   false     - the result went back inline; it was never a background job
	 *   undefined - written before this field existed; treat as a background job
	 *
	 * Every consumer keys on this one field rather than inferring from elapsed time or
	 * from where a notification happens to be fired:
	 *   - the display shows only `!== false`
	 *   - the journal records only `!== false`
	 *
	 * Inferring was the actual defect: the display was fixed by moving a notification and
	 * the journal was left recording everything, because the record itself could not say
	 * what it was.
	 */
	isBackgroundJob?: boolean;
}

export interface StartProcessOptions {
	name?: string;
	command: string;
	/** Shell to run through. Defaults to the platform shell. */
	shell?: string;
	shellArgs?: string[];
	timeoutSeconds?: number;
	/** Wake the agent when this finishes. Defaults to true. */
	triggerOnCompletion?: boolean;
	/** Human-readable label used in notifications. */
	label?: string;
	channel?: JobChannel;
	/**
	 * Called once when this job settles, in place of the engine's global notifiers.
	 * Lets the caller deliver the result its own way (for example as a steering message).
	 */
	onSettle?: (record: JobRecord) => void;
}

/** A resolved shell: what to run, how to pass the command, and where Pi's bin dir is. */
export interface ShellSpec {
	shell: string;
	args: string[];
	/** When "stdin", the command is written to the child's stdin instead of argv. */
	commandTransport?: "stdin";
	/** Prepended to PATH for the job, so Pi's bundled tools stay reachable. */
	binDir?: string;
}

/** Injected so the engine itself stays free of any Pi import (and stays unit-testable). */
export type ShellResolver = (explicit?: string) => ShellSpec;

export interface JobHandle {
	id: string;
	name: string;
	record: JobRecord;
}

/** What the engine needs from Pi to deliver a completion. */
export interface DeliveryTarget {
	sendMessage: (
		message: { customType: string; content: string; display: boolean; details: unknown },
		options: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	) => void;
	hasUI: boolean;
	notify: (message: string, type?: "info" | "warning" | "error") => void;
}

/**
 * How a channel turns a finished job into the text the model reads.
 *
 * The framework owns delivery - one batched message, `steer`, deduplicated per job - but
 * it cannot know how to read a particular channel's output stream. Rather than special-
 * case a channel name inside the delivery path, the owner of that channel registers
 * the reader here.
 *
 * Keeping this a registration instead of an import is the whole point: the framework
 * package then has no dependency on the extension that contributes a channel, so either
 * one can be installed, removed, or upgraded alone.
 */
export interface ChannelRenderer {
	/** The value jobs pass as `channel` in {@link StartProcessOptions}. */
	name: string;
	/**
	 * Produce the model-facing text for a settled job.
	 *
	 * May write back onto `record` (a built-in channel may record the session id
	 * here, so a follow-up call can continue the same job's conversation).
	 */
	render: (record: JobRecord, ctx: ChannelRenderContext) => string;
	/** One-line summary for the job list, where space is tight. */
	digest?: (record: JobRecord) => string;
}

/** What a renderer is given: the record plus read access to the job's stored output. */
export interface ChannelRenderContext {
	/**
	 * Read the tail of a job's output file.
	 *
	 * Returns the text and how many bytes were available, so a reader can tell "empty
	 * because there is nothing" from "empty because the tail was cut". Declared as an
	 * object (not a bare string) because that is what `JobStore.tailOutput` actually
	 * returns and what the built-in renderer needs: a string return would leave
	 * `totalBytes` undefined, `undefined > 0` false, and silently skip the file - which is
	 * the JSONL-truncation defect this whole shape exists to avoid.
	 */
	tailOutput: (id: string, maxBytes: number) => { text: string; totalBytes: number };
}

/** Holds the registered channel renderers, keyed by name. */
