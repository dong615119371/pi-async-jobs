/**
 * The async-mode `bash` tool.
 *
 * Behaviour depends on a per-call `mode` the model chooses, with a grace-period
 * default that needs no choice at all:
 *
 *   "auto"       (default) - wait up to the grace period; if the command is still
 *                            running, hand back a job id and let it continue in the
 *                            background.
 *   "background"           - do not wait at all; return a job id immediately.
 *
 * Why a grace period rather than a blanket rule: measured time in a real session was
 * 96 minutes inside tool calls versus 57 minutes of model reasoning, with single
 * stalls of 5+ minutes - nearly all of it waiting on commands. But pushing *every*
 * command into the background is not the fix either, because trivial commands
 * (`ls`, `git status`) would then each cost a round trip. Racing against a deadline
 * gets both cases right without the model having to classify them.
 *
 * There is no "wait" mode on this tool, and no blocking anything anywhere else either. A
 * `wait:true` on `job_status` was tried and then removed: it is the same mistake wearing a
 * different name, because a bounded wait is still a wait. The rule is one line - if the
 * result is not ready, end the turn and let it arrive as a message.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createLocalBashOperations,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { JobEngine } from "./engine.ts";
import type { JobRecord } from "./types.ts";
import { classifyCommand } from "./timeout-policy.ts";
import { StreamDecoder } from "./encoding.ts";
import { DEFAULT_GRACE_MS, adoptionNote, deferNote, planGrace } from "./grace-policy.ts";

/** How long a command may run in the background before it is killed. */
const MANAGED_TIMEOUT_SECONDS = 30 * 60;

/**
 * Delivery/behaviour modes for `bash`. Module scope because `normalizeMode` validates
 * against it and lives outside the factory - keeping it inside was a real defect: every
 * call other than the default failed with "MODES is not defined".
 */
const MODES = ["auto", "background"] as const;
type BashMode = (typeof MODES)[number];

export interface ManagedBashOptions {
	engine: JobEngine;
	/** True when async mode is on; the override is inert otherwise. */
	isEnabled: () => boolean;
	/** Grace period in ms; read per call so a config change needs no reload. */
	getGraceMs?: () => number;
}

export function registerManagedBash(pi: ExtensionAPI, options: ManagedBashOptions): void {
	const { engine, isEnabled, getGraceMs } = options;

	pi.registerTool({
		name: "bash",
		label: "bash",
		description: [
			"Execute a shell command in the current working directory.",
			"There is no way to make this tool block: a command that outlives the grace period always moves to the background, and its result arrives as a message.",
			'  "auto" (default) - waits up to the session grace period (20s unless configured); if it is still running you get a job id and it finishes in the background.',
			'  "background"   - never waits; returns a job id at once.',
			"After getting a job id, carry on with other work and end your turn: the result arrives later as a message. Do not poll it, do not re-run the command. The result will NOT arrive within this turn.",
		].join(" "),
		parameters: Type.Object({
			command: Type.String({ description: "Shell command to execute" }),
			mode: Type.Optional(
				Type.String({
					description:
						'One of "auto" (default) or "background". Leave unset for "auto". ' +
						'Use "background" to skip the grace period entirely. There is no blocking mode.',
				}),
			),
			expectSeconds: Type.Optional(
				Type.Number({
					description:
						"How long you expect this command to take, in seconds. Estimate the TASK, not 'how long am I " +
						"willing to wait' - those are different questions and this parameter only answers the first.\n" +
						"It does NOT kill the command and does NOT limit how long the command may run; that is " +
						"`timeout`. What it decides is how long the tool waits before handing you back a job id.\n" +
						"Three outcomes:\n" +
						"  under 120   - wait exactly that long, then go to the background if still running\n" +
						"  120 or more - do not wait at all; you get a job id immediately. A long estimate IS the " +
						"                  answer 'this is not worth blocking on', so writing a big number does not " +
						"                  buy you an inline result - it buys you the opposite.\n" +
						"  omitted     - use the session default wait, then the same fallback\n" +
						"Underestimating is safe: the command keeps running and its result arrives as a message, " +
						"costing one extra round trip.\n" +
						"Good uses: you have a rough idea it will take 10-60s and would rather get the result now. " +
						"Bad uses: as a substitute for `timeout`, or a large number meant to reserve time. If you " +
						"already know it is long - installs, clones, builds, full test suites - do not estimate at " +
						"all: use mode:\"background\" and skip the wait entirely. Do not use `timeout` for this " +
						"either; the two parameters answer different questions.",
				}),
			),
			timeout: Type.Optional(
				Type.Number({
					description:
						"Seconds before the command is KILLED. This is a kill limit, not a wait limit - for how " +
						"long the tool waits before returning, see `expectSeconds`. If omitted, a per-command " +
						"automatic limit applies: about 15 minutes normally, about 45 for work recognized as long " +
						"(package installs, git clone/fetch/pull/push/gc, docker build/pull/push/compose up, " +
						"cargo/go/gradle/mvn/msbuild/dotnet, cmake/make/ninja/tsc/webpack/vite, curl/wget, " +
						"tar/7z/rsync/robocopy, ffmpeg/yt-dlp, chkdsk/dism/sfc). Note `npm test` and " +
						"`npm run build` are NOT in that list - they get 15 minutes unless you pass `timeout`.",
				}),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (!isEnabled()) {
				// Async mode off: behave like the built-in so registering this override is
				// harmless.
				return runSynchronously(params.command, params.timeout, signal, onUpdate, ctx);
			}

			const mode = normalizeMode(params.mode);
			// Tiered automatic timeout, unless the caller asked for something specific.
			// This replaces the standalone global-timeout extension: slow commands
			// (installs, builds, clones) get a longer hang-detection limit than ordinary
			// ones, so a healthy build is not guillotined while a genuinely stuck command
			// still gets cleaned up.
			const classified = classifyCommand(params.command);
			const timeoutSeconds = params.timeout ?? classified?.secs ?? MANAGED_TIMEOUT_SECONDS;
			const name = params.command.length > 60 ? `${params.command.slice(0, 57)}...` : params.command;

			// How long to wait, decided once. `mode:"background"` means "do not wait", and so
			// does an estimate at or above the threshold - both land in the same no-wait path
			// below, because they are the same decision reached two ways.
			const defaultGraceMs = Math.max(0, getGraceMs?.() ?? DEFAULT_GRACE_MS);
			const plan = planGrace(params.expectSeconds, defaultGraceMs);
			const noWaitReason =
				mode === "background"
					? "background"
					: plan.kind === "defer"
						? deferNote(plan.expectedSeconds)
						: null;

			if (noWaitReason !== null) {
				try {
					const handle = engine.startProcess({
						command: params.command,
						name,
						timeoutSeconds,
						channel: "generic",
					});
					return backgroundReply(engine, handle.id, noWaitReason);
				} catch (error) {
					return startFailure(error);
				}
			}

			try {
				const { id, outcome } = await engine.runWithGrace(
					{ command: params.command, name, timeoutSeconds, channel: "generic" },
					plan.graceMs,
				);
				if (outcome === "adopted") {
					// Delivery is arranged centrally by `engine.onFinished` in index.ts; nothing here
					// needs to know the job was adopted.
					return backgroundReply(engine, id, adoptionNote(plan.graceMs, plan.explicit));
				}
				// Completed inside the grace period: return the real output, like a normal
				// synchronous call. This is the common case for short commands.
				const record = engine.get(id);
				return {
					content: [{ type: "text", text: formatSyncResult(record) }],
					details: { jobId: id, background: false },
					isError: record?.state === "failed",
				};
			} catch (error) {
				return startFailure(error);
			}
		},
	});
}

/**
 * `planGrace`, `adoptionNote` and `deferNote` live in `grace-policy.ts` - they are pure
 * decisions, and keeping them here would have made them untestable (this file imports the
 * Pi SDK, so no test can load it).
 */
function normalizeMode(raw: unknown): BashMode {
	if (typeof raw !== "string") return "auto";
	const lower = raw.trim().toLowerCase();
	return (MODES as readonly string[]).includes(lower) ? (lower as BashMode) : "auto";
}

function backgroundReply(engine: JobEngine, id: string, why: string) {
	// "running" and "queued" are different promises to make. A queued job has not started -
	// it waits for a free slot - and telling the caller it is running invites it to expect
	// output soon, or to conclude the command is stuck when nothing appears.
	const queued = engine.waitingIds().has(id);
	const state = queued
		? `is queued (${why}) - it will start as soon as a slot frees up`
		: `is now running in the background (${why})`;
	return {
		content: [
			{
				type: "text",
				text:
					`Job ${id} ${state}.\n` +
					`This tool call has already returned - it did NOT block.\n\n` +
					`What to do now: carry on with your own work - start the next step of your plan, ` +
					`make another tool call, or simply end your turn. There is nothing to wait for here: ` +
					`when the job finishes, its result is delivered to you as a new message, automatically.\n\n` +
					`Do not poll it, do not re-run the command, and do not read its output file - ` +
					`the result will come to you on its own.`,
			},
		],
		details: { jobId: id, background: true, queued },
	};
}

function startFailure(error: unknown) {
	return {
		content: [
			{ type: "text", text: `Could not start the command: ${error instanceof Error ? error.message : String(error)}` },
		],
		details: undefined,
		isError: true,
	};
}

/** Present a job that finished inside the grace period as an ordinary tool result. */
function formatSyncResult(record: JobRecord | null): string {
	if (!record) return "(the command finished but its record is unavailable)";
	const body = record.output?.trim() || "(no output)";
	if (record.state === "done") return body;
	if (record.timedOut) return `${body}\n\nCommand timed out and was terminated.`;
	return `${body}\n\nCommand failed (exit ${record.exitCode ?? "?"}): ${record.error ?? "unknown error"}`;
}

/**
 * The synchronous path: Pi's own bash operations. Reached only when async mode is off -
 * there is no per-call mode that selects it.
 */
async function runSynchronously(
	command: string,
	timeout: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: ((result: any) => void) | undefined,
	ctx: ExtensionContext,
) {
	const operations = createLocalBashOperations({});
	const chunks: string[] = [];
	// Same encoder-aware reader as the background path: a Windows tool emitting UTF-16LE
	// must not arrive as mojibake just because this call happened to be synchronous.
	const decoder = new StreamDecoder();
	onUpdate?.({ content: [], details: undefined });

	try {
		const result = await operations.exec(command, ctx.cwd, {
			onData: (data: Buffer | string) => {
				chunks.push(typeof data === "string" ? data : decoder.push(Buffer.from(data)));
			},
			signal,
			timeout,
		});

		chunks.push(decoder.flush());
		let text = chunks.join("");
		let truncated = false;
		const lines = text.split("\n");
		if (lines.length > DEFAULT_MAX_LINES || Buffer.byteLength(text, "utf8") > DEFAULT_MAX_BYTES) {
			truncated = true;
			text = lines.slice(-DEFAULT_MAX_LINES).join("\n");
			if (Buffer.byteLength(text, "utf8") > DEFAULT_MAX_BYTES) text = text.slice(-DEFAULT_MAX_BYTES);
			text += `\n\n[Output truncated to the last ${DEFAULT_MAX_LINES} lines / ${formatSize(DEFAULT_MAX_BYTES)}]`;
		}

		const exitCode = result.exitCode;
		if (exitCode !== 0) {
			return {
				content: [{ type: "text", text: `${text}\n\nCommand exited with code ${exitCode}` }],
				details: { truncated },
				isError: true,
			};
		}
		return { content: [{ type: "text", text: text || "(no output)" }], details: { truncated } };
	} catch (error) {
		return {
			content: [
				{ type: "text", text: `Command failed: ${error instanceof Error ? error.message : String(error)}` },
			],
			details: undefined,
			isError: true,
		};
	}
}
