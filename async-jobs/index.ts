/**
 * async-jobs - background job framework for Pi.
 *
 * The problem: Pi's agent loop is synchronous by design. A tool call must return
 * before the model generates again, so a five-minute build blocks everything.
 *
 * The shape of the fix is to remove the *wait* from the tool side rather than to
 * change the loop. A slow command returns a handle immediately; the model keeps working;
 * the result arrives later as a message that resumes the conversation.
 *
 * What this gives the model:
 *   bash         runs in the background when async mode is on (that is the default)
 *   job_status   list jobs, read results, clean up
 *   job_logs     tail a job's output
 *   job_kill     stop a running job
 *
 * And the commands: /async, /jobs, /job-logs, /job-kill, /job-history
 *
 * Design constraints honoured here:
 * - Jobs survive the model going idle: each terminal job is delivered once, and the
 *   record is on disk so nothing is lost if the session ends first.
 * - Kill is real: the whole process tree is terminated, and the caller waits for
 *   the process to be gone rather than assuming a signal worked.
 * - Shutdown cleans up: every `session_shutdown` reason orphans children, so all of
 *   them trigger an idempotent sweep.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir, getShellConfig } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { BatchCollector, formatBatch } from "./batch.ts";
import { JobJournal, formatJournalEntry } from "./journal.ts";
import {
	buildWidgetLines,
	formatFooter,
	widgetSignature,
} from "./status-line.ts";
import { JobEngine } from "./engine.ts";
import {
	registerChannel,
	getChannel,
	digestFor,
	renderAndPersist,
} from "./channels.ts";
import { registerManagedBash } from "./managed-bash.ts";
import { JobStore } from "./store.ts";
import type { JobRecord } from "./types.ts";

/**
 * The framework's tools are registered but NOT activated by default.
 *
 * Rationale: these tools change how the model works at a structural level - it is
 * meant to fire a job and carry on instead of waiting. That is the right default for
 * long work and the wrong default for ordinary conversation, so activation is left to
 * the `异步模式` preset, which names them in its tool list.
 *
 * `defaultActive: false` keeps them out of the model's tool list while still allowing
 * `pi.setActiveTools()` to bring them in. `exposure: "hidden"` would not work for
 * that, because activation ignores hidden tools.
 */
const TOOL_DEFAULTS = { defaultActive: false } as const;

/** Every tool this framework can expose. The preset names these to switch the mode on. */
export const ASYNC_JOB_TOOLS = ["job_status", "job_logs", "job_kill", "job_history"] as const;

const PREVIEW_CHARS = 1200;

/** Jobs started by a subagent are refused: delegation must not recurse. */
const SUBAGENT_DEPTH_ENV = "PI_SUBAGENT_DEPTH";

function jobRoot(): string {
	return path.join(getAgentDir(), "async-jobs");
}


function formatAge(record: JobRecord): string {
	const end = record.finishedAt ?? Date.now();
	const secs = Math.max(0, Math.round((end - record.startedAt) / 1000));
	if (secs < 60) return `${secs}s`;
	if (secs < 3600) return `${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, "0")}s`;
	return `${Math.floor(secs / 3600)}h${String(Math.floor((secs % 3600) / 60)).padStart(2, "0")}m`;
}

function stateLabel(state: JobRecord["state"]): string {
	switch (state) {
		case "running":
			return "RUNNING";
		case "done":
			return "DONE   ";
		case "failed":
			return "FAILED ";
		case "killed":
			return "KILLED ";
	}
}

function preview(text: string, max = PREVIEW_CHARS): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}...`;
}

/**
 * A one-line digest for `job_status`.
 *
 * Why not a flat preview: asking job_status for eight jobs used to dump up to 300
 * chars each, so a single poll cost more context than the results themselves. A
 * status poll only needs to answer "which of these is worth reading", so it gets one
 * line plus the path - the full body is still one `job_logs` call away.
 */
function digest(record: JobRecord): string {
	if (record.state === "running") {
		return `(running) ${record.summary.slice(0, 110)}`;
	}
	// A channel that knows its own output stream may have something terser to say than the
	// first line - a JSONL stream's first line is a fragment and reads as garbage. The
	// channel registers that knowledge; this file does not carry a branch per channel.
	//
	// The gate must test for a `digest`, not for a renderer: `generic` registers a renderer
	// without one, and routing it here would replace the size+first-line summary below with
	// a bare `done (exit 0)` - losing the very line a model uses to decide whether to open
	// job_logs. Audited and measured; see A1.
	if (getChannel(record.channel)?.digest) return digestFor(record);
	const body = record.state === "done" ? (record.output ?? "") : (record.error ?? record.output ?? "");
	const firstLine =
		body
			.split(/\r?\n/)
			.map((line) => line.trim())
			.find((line) => line.length > 0) ?? "(no output)";
	const size = body.length > 0 ? `${Math.round(body.length / 1024)}KB` : "0KB";
	return `${size}  ${firstLine.slice(0, 110)}`;
}

export default function (pi: ExtensionAPI) {
	// Delegation is one level deep: a subagent must not spawn background jobs, or a
	// task could migrate outward forever and never come back.
	const depth = Number.parseInt(process.env[SUBAGENT_DEPTH_ENV] ?? "0", 10) || 0;
	if (depth > 0) return;

	const store = new JobStore(jobRoot());

	// The durable history of every job that ever finished. Separate from `store` because
	// that is working state - pruned by count and age, deleted along with its output -
	// while this is meant to outlive it and answer "what ran, and what did it print?".
	const journal = new JobJournal(jobRoot());

	// ───────────────────────── 后台作业的可见状态 ─────────────────────────
	//
	// 没有这块之前，用户完全不知道有作业在跑——最多只知道"模型好像有点慢"。
	// 一个卡住的作业可以安静地烧 CPU，而唯一的线索是直觉。
	//
	// 两个位置一起用：footer 一行给"有没有"，编辑器上方给"是什么、跑了多久"。
	// 作业归零时两块一起清掉，不留下僵尸文案。
	//
	// 只在交互式会话里挂：子代理没有 UI，RPC 客户端的渲染能力也不一致。
	let displayCtx: ExtensionContext | null = null;
	let displayTimer: NodeJS.Timeout | null = null;
	let lastFooter = "";
	let lastWidget = "";

	const renderDisplay = (): void => {
		if (!displayCtx?.hasUI) return;
		const waiting = engine.waitingIds();
		// Only real background jobs belong on screen. Keying on the record's own flag rather
		// than on when a notification happened to fire keeps this and the journal agreeing
		// by construction, instead of agreeing by coincidence.
		const inFlight = engine
			.all()
			.filter((r) => r.state === "running" && r.isBackgroundJob !== false);
		// A queued job is already a `running` record, so subtract it or it is reported twice.
		const executing = inFlight.length - inFlight.filter((r) => waiting.has(r.id)).length;

		const footer = formatFooter(executing, waiting.size);
		if (footer !== lastFooter) {
			// An empty string clears the entry for this key; undefined would be the
			// documented spelling, but an empty footer is treated as absent either way.
			displayCtx.ui.setStatus("async-jobs", footer === "" ? undefined : footer);
			lastFooter = footer;
		}

		const lines = buildWidgetLines(inFlight, Date.now(), waiting);
		const signature = widgetSignature(lines);
		if (signature !== lastWidget) {
			displayCtx.ui.setWidget("async-jobs", lines.length === 0 ? undefined : lines, {
				placement: "aboveEditor",
			});
			lastWidget = signature;
		}
	};

	// A one-second tick keeps the elapsed column moving. It runs only while something is
	// on screen, so an idle session pays nothing and the timer cannot outlive the session.
	const syncDisplayTimer = (): void => {
		const wanted =
			displayCtx?.hasUI === true &&
			engine.all().some((r) => r.state === "running" && r.isBackgroundJob !== false);
		if (wanted && displayTimer === null) {
			displayTimer = setInterval(renderDisplay, 1000);
		} else if (!wanted && displayTimer !== null) {
			clearInterval(displayTimer);
			displayTimer = null;
		}
	};

	const refreshDisplay = (): void => {
		syncDisplayTimer();
		renderDisplay();
	};
	const engine = new JobEngine({
		store,
		// Inject Pi's own shell resolution so a background job uses exactly the same shell
		// as a foreground command. Pi's resolver prefers a known Git Bash path over PATH,
		// which matters on Windows where a bare "bash" resolves to the WSL forwarder.
		resolveShell: (explicit) => {
			const cfg = getShellConfig(explicit);
			return { shell: cfg.shell, args: cfg.args, commandTransport: cfg.commandTransport as "stdin" | undefined, binDir: path.join(getAgentDir(), "bin") };
		},
		target: {
			sendMessage: (message, options) => pi.sendMessage(message as never, options),
			hasUI: true,
			notify: () => {
				/* notifications from the engine are not used; the UI is driven by tools */
			},
		},
	});

	// Every terminal job is announced once, here. The job record is already durable
	// at this point, so a failure to deliver cannot lose the result.
	// ── Batched completion delivery ────────────────────────────────────────────────
	//
	// Results are grouped by time rather than announced one at a time.
	//
	// Why: when several jobs finish close together - the normal case after dispatching a
	// batch - announcing each separately wakes the model several times for what is
	// conceptually one piece of news, and each wake-up costs a full model round trip.
	//
	// Why not Pi's own `steeringMode: "all"`: that setting drains whatever is queued at
	// the moment the loop reaches a drain point, but it does not wait. Measured with three
	// jobs finishing at 8s, 9s and 10s: the first was delivered alone at +14.5s, and only
	// the other two were grouped. A debounce is required to give late arrivals a chance to
	// join, so this holds finished jobs for a short window before releasing them together.
	//
	// The window is deliberately small. A longer one would group more but delay every
	// result, and the point of the mode is to shorten waits, not lengthen them.
	const BATCH_WINDOW_MS = 3000;

	interface PendingDelivery {
		record: JobRecord;
		text: string;
	}

	// How many jobs are still in flight when a delivery goes out.
	//
	// Without this a model that fired eight background jobs gets eight unrelated messages and
	// cannot tell whether it is done or still waiting - so it issues job_status calls to
	// find out, which is pure waste. One number in the footer removes that whole class of
	// redundant poll. Counts queued jobs too: they read as "still coming".
	function inFlightNote(): string {
		const remaining = engine.activeCount() + engine.queuedCount();
		if (remaining <= 0) return "";
		const ids = engine
			.all()
			.filter((r) => r.state === "running")
			.map((r) => r.id)
			.slice(0, 6);
		const more = remaining > ids.length ? ` +${remaining - ids.length} more` : "";
		return ` [${remaining} still running: ${ids.join(", ")}${more}]`;
	}

	// The debounce itself lives in ./batch.ts so it has test coverage; this wires it to
	// Pi. Keeping a second copy of the logic here would guarantee the two drift apart.
	const collector = new BatchCollector<PendingDelivery>({
		windowMs: BATCH_WINDOW_MS,
		deliver: (items) => {
			const text = formatBatch(items, (item) => item.text) + inFlightNote();
			try {
				pi.sendMessage(
					{
						customType: "async-job-batch",
						content: text,
						display: true,
						details: { ids: items.map((item) => item.record.id), count: items.length },
					},
					{ triggerTurn: true, deliverAs: "steer" },
				);
			} catch {
				// The session may be tearing down; each record is already durable on disk and
				// remains readable through job_status.
			}
		},
	});

	engine.onStarted(() => {
		refreshDisplay();
	});

	// The display observes every terminal job, not just delivered ones. `onFinished` is the
	// delivery channel and is skipped when a result was handed back inline (a command that
	// finished inside the grace period) - so hooking the display there would leave that
	// job's row on screen forever.
	engine.onTerminal((record) => {
		// Record history here for the same reason: a command that finished inside the grace
		// period never reaches onFinished, and would otherwise be missing from the journal -
		// exactly the short commands that make up most of a session.
		journal.append(record);
		refreshDisplay();
	});

	engine.onFinished((record) => {
		if (record.killedByUser) return;
		// Which reader applies is the channel's business, registered by whoever contributed
		// it. A hardcoded branch here is what made this package depend on the channel's.
		//
		// `renderAndPersist` does the rendering and then re-writes the record: a renderer may
		// have written facts back (a channel may keep the session id and tool-call
		// count in `record.stats`), and `engine.finish` wrote the record BEFORE this callback
		// ran. Without the second write those facts would exist only in memory and vanish on
		// the next session - the digest's "N tool calls" would go to 0. This is the write the
		// old `engine.deliver` did after formatting; batching delivery dropped it (audited P2).
		const text = renderAndPersist(
			record,
			{ tailOutput: (id, maxBytes) => store.tailOutput(id, maxBytes) },
			(r) => store.write(r),
		);
		collector.add({ record, text });
	});

	// Release anything still held when the session ends, so a result is never lost.
	pi.on("session_shutdown", () => {
		collector.flush();
	});

	// ---------------------------------------------------------------- session

	pi.on("session_start", (_event, ctx) => {
		// The display needs a context to draw into. Captured here rather than in the
		// factory because `ctx` is only valid per event, and the factory runs before the
		// runtime is ready.
		displayCtx = ctx;
		refreshDisplay();

		const recovered = engine.recover();
		if (recovered.length > 0 && ctx.hasUI) {
			ctx.ui.notify(
				// Say only what is known. A job listed here was still marked `running` when the
				// previous session ended, but its process may well have kept going and finished
				// afterwards - an out-of-session `delegate` does exactly that. Calling it
				// "interrupted" would be a guess stated as fact.
				//
				// Only the id and kind are shown. `name` carries the first characters of the
				// command or task, which routinely holds paths, code or other things the user did
				// not ask to see on startup.
				`${recovered.length} background job(s) were still running when the last session ended.\n` +
					`Their current state is unknown - check with job_status:\n` +
					recovered.map((j) => `  ${j.id}  (${j.kind})`).join("\n") +
					`\nRecords: ${store.dir()}`,
				"warning",
			);
		}
	});

	// Every shutdown reason (quit, reload, new, resume, fork) leaves children
	// orphaned, so all of them sweep. `shutdownAll` is idempotent.
	pi.on("session_shutdown", async (event, ctx) => {
		// Stop the ticker and wipe both display slots before anything else: a leftover
		// interval would keep drawing into a dead context, and a stale footer would
		// survive into the next session's screen.
		if (displayTimer !== null) {
			clearInterval(displayTimer);
			displayTimer = null;
		}
		if (ctx.hasUI) {
			ctx.ui.setStatus("async-jobs", undefined);
			ctx.ui.setWidget("async-jobs", undefined);
		}
		displayCtx = null;

		const { killed, leaked } = await engine.shutdownAll(event.reason);
		if (leaked > 0 && ctx.hasUI) {
			ctx.ui.notify(
				`${leaked} background job(s) could not be fully terminated; descendant processes may have leaked.`,
				"error",
			);
		}
		void killed;
	});

	// ------------------------------------------------------------------ tools

	// `job_run` was removed.
	//
	// It started a background command, which `bash` now does directly: with async mode on,
	// `bash` already returns a job id, and its `mode: "background"` covers the explicit
	// case. Two tools doing the same thing made the choice harder for the model without
	// giving it anything new - the same reason duplicate tools were retired.

	pi.registerTool({
		...TOOL_DEFAULTS,
		name: "job_status",
		label: "Job status",
		description: [
			"List background jobs and read their results.",
			"Omit `jobs` to see everything tracked. Set `cleanup: true` to delete the durable records of finished jobs.",
			"Set `verbose: true` for the full result rather than a preview.",
		].join(" "),
		parameters: Type.Object({
			jobs: Type.Optional(Type.Array(Type.String(), { description: "Job ids to report on. Omit for all." })),
			cleanup: Type.Optional(Type.Boolean({ description: "Delete records of finished jobs after reporting." })),
			verbose: Type.Optional(Type.Boolean({ description: "Include the full result instead of a preview." })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			// Only real background jobs. A command that finished inside the grace period was never
			// one: its result went back inline, its record was removed from disk, and listing it
			// here made the same id answerable one moment and "Unknown job" the next (the memory
			// record survives until evict(), the disk record is already gone). The display and the
			// journal both filter on this field; this was the one consumer that did not.
			const visible = (r: JobRecord) => r.isBackgroundJob !== false;
			const records =
				params.jobs && params.jobs.length > 0
					? params.jobs.flatMap((id) => {
							const { record, error } = engine.resolve(id);
							if (record) return [record];
							if (error) return [{ ...(engine.get(id) ?? ({} as JobRecord)), id, state: "failed" as const, error }];
							return [];
						})
					: engine.all().filter(visible);

			if (records.length === 0) {
				// Say which case this is. "Nothing has ever run" and "everything you listed finished
				// inline and was never a background job" are different answers, and the second one
				// used to be indistinguishable from the first.
				const text =
					params.jobs && params.jobs.length > 0
						? `No job matches ${params.jobs.join(", ")}.`
						: "No background jobs have been started in this session.";
				return { content: [{ type: "text", text }], details: undefined };
			}

			const verbose = params.verbose ?? false;
			const lines = records.map((record) => {
				const head = `${stateLabel(record.state)} ${record.id}  ${formatAge(record)}  ${record.name}`;
				const body = verbose
					? record.state === "running"
						? "(still running)"
						: preview(
								record.state === "done" ? (record.output ?? "(no output)") : (record.error ?? "(failed)"),
								8000,
							)
					: digest(record);
				return `${head}\n  ${body}`;
			});

			const running = records.filter((r) => r.state === "running").length;
			const done = records.filter((r) => r.state === "done").length;
			const failed = records.filter((r) => r.state === "failed").length;
			const killed = records.filter((r) => r.state === "killed").length;
			const queued = engine.queuedCount();
			const summary =
				`${records.length} job(s): ${done} done, ${failed} failed, ${killed} killed, ${running} running` +
				(queued > 0 ? `, ${queued} queued` : "");

			let cleanupNote = "";
			if (params.cleanup) {
				const finished = records.filter((r) => r.state !== "running");
				for (const record of finished) store.remove(record.id);
				cleanupNote = finished.length > 0 ? `\nRemoved ${finished.length} finished record(s) from disk.` : "";
			}

			return {
				content: [{ type: "text", text: `${summary}${cleanupNote}\n\n${lines.join("\n\n")}` }],
				details: { jobs: records.map((r) => ({ id: r.id, state: r.state, name: r.name })) },
			};
		},

		renderCall(args, theme, _context) {
			let text = `${theme.fg("toolTitle", theme.bold("job_status"))}`;
			if (args.jobs?.length) text += theme.fg("dim", ` ${args.jobs.join(", ")}`);
			if (args.cleanup) text += theme.fg("warning", " [cleanup]");
			return new Text(text, 0, 0);
		},
		renderResult(result, _opts, theme, _context) {
			const first = result.content[0];
			return new Text(theme.fg("toolOutput", first?.type === "text" ? first.text : ""), 0, 0);
		},
	});

	pi.registerTool({
		...TOOL_DEFAULTS,
		name: "job_logs",
		label: "Job logs",
		description:
			"Read the latest output of a background job, whether it is still running or finished. Output is read from the job's log file.",
		parameters: Type.Object({
			id: Type.String({ description: "Job id (an unambiguous prefix is accepted)" }),
			maxBytes: Type.Optional(Type.Number({ description: "Maximum bytes to return from the end. Default 4000." })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const { record, error } = engine.resolve(params.id);
			if (!record) {
				return { content: [{ type: "text", text: error ?? `Unknown job: ${params.id}` }], details: undefined };
			}
			const maxBytes = params.maxBytes ?? 4000;
			const { text, truncated, totalBytes } = engine.logs(record.id, maxBytes);
			const notice = truncated
				? `\n\n[Showing the last ${maxBytes} of ${totalBytes} bytes. Full output: ${store.outputPathFor(record.id)}]`
				: "";
			return {
				content: [
					{
						type: "text",
						text: `${record.id} (${record.state}) - ${record.name}\n\n${text || "(no output yet)"}${notice}`,
					},
				],
				details: { id: record.id, state: record.state },
			};
		},

		renderCall(args, theme, _context) {
			return new Text(`${theme.fg("toolTitle", theme.bold("job_logs"))} ${theme.fg("dim", args.id)}`, 0, 0);
		},
		renderResult(result, _opts, theme, _context) {
			const first = result.content[0];
			return new Text(theme.fg("toolOutput", first?.type === "text" ? first.text : ""), 0, 0);
		},
	});

	pi.registerTool({
		...TOOL_DEFAULTS,
		name: "job_kill",
		label: "Kill job",
		description:
			"Stop a running background job. The whole process tree is terminated, not just the top process.",
		parameters: Type.Object({
			id: Type.String({ description: "Job id (an unambiguous prefix is accepted)" }),
			reason: Type.Optional(Type.String({ description: "Why the job is being stopped" })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const { record, error } = engine.resolve(params.id);
			if (!record) {
				return { content: [{ type: "text", text: error ?? `Unknown job: ${params.id}` }], details: undefined };
			}
			const result = await engine.kill(record.id, params.reason ?? "killed on request");
			return {
				content: [{ type: "text", text: result.message }],
				details: { id: record.id, ok: result.ok },
			};
		},

		renderCall(args, theme, _context) {
			return new Text(`${theme.fg("toolTitle", theme.bold("job_kill"))} ${theme.fg("accent", args.id)}`, 0, 0);
		},
		renderResult(result, _opts, theme, _context) {
			const first = result.content[0];
			return new Text(theme.fg("toolOutput", first?.type === "text" ? first.text : ""), 0, 0);
		},
	});

	// ------------------------------------------------------------- job history

	pi.registerTool({
		...TOOL_DEFAULTS,
		name: "job_history",
		label: "Job history",
		description: [
			"The durable log of every background job that has ever finished, oldest first.",
			"Unlike `job_status` (which lists what this session still has in memory), this survives",
			"session restarts, `/reload`, and the retention cleanup that deletes old job records.",
			"Use it to answer \"what did I run earlier, and what did it print?\", or to look up a job id",
			"from a previous session.",
			"Returns the most recent `count` entries (default 20). Set `full: true` to see complete output.",
		].join(" "),
		parameters: Type.Object({
			count: Type.Optional(Type.Number({ description: "How many recent entries to show. Default 20." })),
			id: Type.Optional(Type.String({ description: "Filter to one job id." })),
			full: Type.Optional(Type.Boolean({ description: "Show complete output rather than a preview." })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const limit = Math.max(1, Math.min(200, Math.floor(params.count ?? 20)));
			const entries = params.id
				? journal.tail(5000).filter((entry) => entry.id === params.id)
				: journal.tail(limit);

			if (entries.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: params.id
								? `No history entry for ${params.id}. It may never have finished, or the journal is new.`
								: `No job history yet. Entries are written to ${journal.path()} as jobs finish.`,
						},
					],
					details: { count: 0 },
				};
			}

			const body = entries.map((entry) => formatJournalEntry(entry, params.full === true)).join("\n\n");
			return {
				content: [
					{
						type: "text",
						text: `${entries.length} entr${entries.length === 1 ? "y" : "ies"} (${journal.count()} total, ${journal.path()}):\n\n${body}`,
					},
				],
				details: { count: entries.length },
			};
		},

		renderCall(args, theme, _context) {
			const id = args.id ? ` ${theme.fg("accent", args.id)}` : "";
			return new Text(`${theme.fg("toolTitle", theme.bold("job_history"))}${id}`, 0, 0);
		},

		renderResult(result, _opts, theme, _context) {
			const first = result.content[0];
			const text = first?.type === "text" ? first.text : "";
			return new Text(theme.fg("toolOutput", text.split("\n").slice(0, 12).join("\n")), 0, 0);
		},
	});
	// --------------------------------------------------------------- commands

	// ─────────────────────────────── 异步模式开关 ───────────────────────────────
	//
	// The framework's tools are registered with `defaultActive: false`, so by default
	// the model cannot see them. This command is the switch: it puts them into the
	// active set, or takes them out again.
	//
	// The choice is written to a state file rather than kept in memory, because a
	// session-local flag would silently reset on every new session - the user would
	// turn the mode on, start a new conversation, and find their long-running work
	// suddenly blocking again with no explanation.

	const STATE_FILE = path.join(jobRoot(), "mode.json");

	/**
	 * Grace period, in seconds, for `bash` when `mode` is "auto".
	 *
	 * Configurable because the right value is workload-dependent: 20s suits a mix of
	 * quick inspections and slow builds, but a machine that mostly runs 5-minute test
	 * suites would rather not push every one of them into the background. Changing it
	 * needs no code edit and no reload - it is read per call.
	 */
	const CONFIG_FILE = path.join(jobRoot(), "config.json");
	const DEFAULT_GRACE_SECONDS = 20;

	function readGraceMs(): number {
		try {
			const raw = fs.readFileSync(CONFIG_FILE, "utf8");
			const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
			const parsed = JSON.parse(text);
			const seconds = Number(parsed?.graceSeconds);
			if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
		} catch {
			/* missing or malformed: fall back to the default */
		}
		return DEFAULT_GRACE_SECONDS * 1000;
	}

	function readModeEnabled(): boolean {
		try {
			const raw = fs.readFileSync(STATE_FILE, "utf8");
			// Strip a UTF-8 BOM before parsing. PowerShell's `Set-Content -Encoding utf8`
			// writes one, and `JSON.parse` rejects it - which meant a mode file written by
			// any external tool left the switch permanently reading as "off" (measured:
			// the file said enabled=true and the extension still reported disabled).
			const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
			const parsed = JSON.parse(text);
			return parsed?.enabled === true;
		} catch {
			return false;
		}
	}

	function writeModeEnabled(enabled: boolean): void {
		try {
			fs.mkdirSync(jobRoot(), { recursive: true });
			fs.writeFileSync(STATE_FILE, JSON.stringify({ enabled }), { encoding: "utf8", mode: 0o600 });
		} catch {
			/* best effort: the mode still applies for this session */
		}
	}

	/**
	 * Put the framework's tools into the active set, or take them out.
	 *
	 * Only the names this extension owns are touched, so whatever else is active -
	 * from another preset, a `--tools` flag, or the user's defaults - is preserved.
	 */
	function applyMode(enabled: boolean): { added: string[]; removed: string[]; unexpected: string[] } {
		const active = new Set(pi.getActiveTools());
		const known = new Set(pi.getAllTools().map((tool) => tool.name));
		const added: string[] = [];
		const removed: string[] = [];
		const unexpected = ASYNC_JOB_TOOLS.filter((name) => !known.has(name));

		for (const name of ASYNC_JOB_TOOLS) {
			if (!known.has(name)) continue;
			if (enabled) {
				if (!active.has(name)) {
					active.add(name);
					added.push(name);
				}
			} else if (active.has(name)) {
				active.delete(name);
				removed.push(name);
			}
		}
		if (added.length > 0 || removed.length > 0) pi.setActiveTools([...active]);
		return { added, removed, unexpected };
	}

	pi.registerCommand("async", {
		description: "异步模式开关：/async on 开启，/async off 关闭，/async 查看当前状态",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			const current = readModeEnabled();

			if (arg === "" || arg === "status") {
				const active = pi.getActiveTools();
				const visible = ASYNC_JOB_TOOLS.filter((name) => active.includes(name));
				const running = engine.activeCount();
				ctx.ui.notify(
					`异步模式：${current ? "已开启" : "已关闭"}\n` +
						`模型可见工具：${visible.length > 0 ? visible.join(", ") : "（无）"}\n` +
						`正在运行的后台作业：${running}${engine.queuedCount() > 0 ? `，排队 ${engine.queuedCount()}` : ""}\n\n` +
						`/async on 开启（模型可把长任务丢后台）\n` +
						`/async off 关闭（模型看不到后台工具，已跑的作业不受影响）`,
					"info",
				);
				return;
			}

			if (arg !== "on" && arg !== "off") {
				ctx.ui.notify(`未知参数 "${arg}"。用法：/async on  |  /async off  |  /async (查看状态)`, "warning");
				return;
			}

			const enabled = arg === "on";
			if (enabled === current) {
				ctx.ui.notify(`异步模式已经是${enabled ? "开启" : "关闭"}状态。`, "info");
				return;
			}

			const result = applyMode(enabled);
			writeModeEnabled(enabled);

			const problems =
				result.unexpected.length > 0 ? `\n⚠ 这些工具未注册：${result.unexpected.join(", ")}` : "";

			if (enabled) {
				const running = engine.activeCount();
				ctx.ui.notify(
					`异步模式已开启。模型现在可用：${result.added.join(", ") || "（已可用）"}${problems}\n\n` +
						`长任务会先返回作业号，模型继续干活，完成后自动唤醒。` +
						(running > 0 ? `\n当前有 ${running} 个作业在后台运行，不受此开关影响。` : ""),
					"info",
				);
			} else {
				const running = engine.activeCount();
				ctx.ui.notify(
					`异步模式已关闭。模型不再看到后台工具${problems}\n\n` +
						(running > 0
							? `⚠ 仍有 ${running} 个作业在后台运行。它们会继续跑完并照常唤醒模型；` +
								`想立刻停掉用 /jobs 查看，再用 /job-kill <id>。`
							: "没有正在运行的后台作业。"),
					"info",
				);
			}
		},
	});

	// Re-apply the saved choice on every session start. It must happen here, not in the
	// factory: calling `getAllTools`/`setActiveTools` during extension loading throws
	// "Extension runtime not initialized", and a try/catch around it would swallow the
	// failure and leave the mode silently off (measured exactly that).
	pi.on("session_start", (_event, ctx) => {
		if (!readModeEnabled()) return;
		try {
			const result = applyMode(true);
			if (ctx.hasUI && result.unexpected.length > 0) {
				ctx.ui.notify(`异步模式：这些工具未注册 → ${result.unexpected.join(", ")}`, "warning");
			}
		} catch (error) {
			if (ctx.hasUI) {
				ctx.ui.notify(
					`异步模式未能开启：${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		}
	});

	pi.registerCommand("jobs", {
		description: "List background jobs. Add 'cleanup' to delete finished records.",
		handler: async (args, ctx) => {
			const cleanup = args.trim().toLowerCase().includes("cleanup");
			// Same filter as `job_status`: a command that completed inside the grace period is not
			// a background job and must not appear here either.
			const all = engine.all().filter((r) => r.isBackgroundJob !== false);
			if (all.length === 0) {
				ctx.ui.notify("No background jobs.", "info");
				return;
			}
			if (cleanup) {
				for (const record of all.filter((r) => r.state !== "running")) store.remove(record.id);
			}
			const running = all.filter((r) => r.state === "running");
			const summary = all.map((r) => `${stateLabel(r.state)} ${r.id} ${formatAge(r)}  ${r.name}`).join("\n");
			ctx.ui.notify(
				`${all.length} job(s), ${running.length} running${cleanup ? " (records cleaned)" : ""}\n${summary}`,
				"info",
			);
		},
	});

	pi.registerCommand("job-kill", {
		description: "Stop a background job: /job-kill <id>",
		handler: async (args, ctx) => {
			const id = args.trim();
			if (!id) {
				ctx.ui.notify("Usage: /job-kill <job-id>", "warning");
				return;
			}
			const { record, error } = engine.resolve(id);
			if (!record) {
				ctx.ui.notify(error ?? `Unknown job: ${id}`, "error");
				return;
			}
			const result = await engine.kill(record.id, "killed via /job-kill");
			ctx.ui.notify(result.message, result.ok ? "info" : "warning");
		},
	});

	pi.registerCommand("job-logs", {
		description: "Show a background job's output: /job-logs <id>",
		handler: async (args, ctx) => {
			const id = args.trim();
			if (!id) {
				ctx.ui.notify("Usage: /job-logs <job-id>", "warning");
				return;
			}
			const { record, error } = engine.resolve(id);
			if (!record) {
				ctx.ui.notify(error ?? `Unknown job: ${id}`, "error");
				return;
			}
			const { text, truncated, totalBytes } = engine.logs(record.id, 3000);
			const notice = truncated ? `\n\n[last 3000 of ${totalBytes} bytes]` : "";
			ctx.ui.notify(`${record.id} (${record.state}) - ${record.name}\n\n${text || "(no output yet)"}${notice}`, "info");
		},
	});

	// Durable history for the user too. `/jobs` shows what this session still holds in
	// memory and disappears on restart; this one does not.
	pi.registerCommand("job-history", {
		description: "Show the durable log of finished jobs: /job-history [count]",
		handler: async (args, ctx) => {
			const requested = Number.parseInt(args.trim(), 10);
			const count = Number.isFinite(requested) && requested > 0 ? Math.min(200, requested) : 15;
			const entries = journal.tail(count);
			if (entries.length === 0) {
				ctx.ui.notify(`No job history yet. Entries land in ${journal.path()} as jobs finish.`, "info");
				return;
			}
			const body = entries.map((entry) => formatJournalEntry(entry)).join("\n\n");
			ctx.ui.notify(`${entries.length} of ${journal.count()} entries\n\n${body}`, "info");
		},
	});

	// Replace the built-in `bash` with the async-managed version.
	//
	// Registering the same name overrides the built-in tool. While async mode is off the
	// override forwards to Pi's own bash operations, so nothing changes; while it is on,
	// every command runs in the background and there is no synchronous path left. That is
	// the point of the mode: a documented convention gets ignored under load, so the
	// default itself has to stop offering the wait.
	// ── Take over the `es` timeout, absorbed from the retired global-timeout extension ──
	//
	// `es-search` expects an outside party to inject `timeoutSeconds`; its own fallback is
	// only 15s, so removing the old extension without this would silently halve the search
	// budget. Managing it here keeps every timeout decision in one place.
	//
	// An explicit value from the model is always respected - the injector only fills a gap.
	// Harmless when `es` is not installed: the handler simply never fires.
	const ES_TIMEOUT_SECONDS = 30;

	pi.on("tool_call", (event) => {
		if (event.toolName !== "es") return;
		const input = event.input as Record<string, unknown>;
		if (input.timeoutSeconds !== undefined) return;
		input.timeoutSeconds = ES_TIMEOUT_SECONDS;
	});

	registerManagedBash(pi, {
		engine,
		isEnabled: readModeEnabled,
		getGraceMs: readGraceMs,
	});

	// The built-in channel is registered like any other. Registration is idempotent, so a
	// reloaded extension replaces its own entry instead of stacking duplicates.
	registerGenericChannel();
}

/**
 * The built-in `generic` channel: a plain command and its combined output.
 *
 * Registered like any other channel rather than special-cased, so there is exactly one
 * way a result reaches the model. A channel that was never registered still delivers via
 * the framework's own fallback.
 */
function registerGenericChannel(): () => void {
	return registerChannel({
		name: "generic",
		render: (record) => {
			const age = record.finishedAt ? Math.round((record.finishedAt - record.startedAt) / 1000) : 0;
			const header = `[Background job ${record.id} ${record.state}] ${age}s, exit ${record.exitCode ?? "?"}`;
			if (record.state === "done") {
				return `${header}\n\nCommand: ${record.summary.slice(0, 200)}\n\nOutput:\n${preview(record.output ?? "(no output)")}`;
			}
			if (record.timedOut) {
				return `${header}\n\nCommand: ${record.summary.slice(0, 200)}\n\nThe job timed out and was terminated. Output so far:\n${preview(record.output ?? "(no output)")}`;
			}
			return `${header}\n\nCommand: ${record.summary.slice(0, 200)}\n\n${record.error ?? "(failed)"}\n\nOutput:\n${preview(record.output ?? "(none)")}`;
		},
	});
}
