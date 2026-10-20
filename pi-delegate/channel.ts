/**
 * OpenCode delegate channel.
 *
 * Runs one `opencode-cli` invocation as a generic async job and decodes its JSONL
 * stream into a human result. This is what replaces the bespoke
 * `delegate_background` implementation: the job lifecycle, concurrency, kill, and
 * persistence all come from the engine, so the only thing specific to OpenCode is
 * how the command is built and how the output is read.
 *
 * Two details that matter and are easy to get wrong:
 *
 * 1. The task is passed as base64 and decoded inside the shell. Passing a multi-line
 *    prompt as a shell argument truncates it at the newline (measured: only the first
 *    line reached the delegate). Base64 keeps the prompt intact through any quoting.
 *
 * 2. `--standalone` is mandatory. Without it the CLI talks to the shared background
 *    service, whose working directory is the user's home; delegates then cannot find
 *    the requested paths and fall back to scanning the whole drive (measured: 40s
 *    timeout, zero files changed).
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** Free-tier models only: the whole point of delegating here is that it costs nothing. */
export function encodeTask(task: string): string {
	return Buffer.from(task, "utf8").toString("base64");
}

export interface DelegateCommandOptions {
	cli: string;
	task: string;
	model: string;
	agent: string;
	files?: string[];
	title?: string;
	/** Reuse an existing OpenCode session, keeping the delegate's context. */
	session?: string;
	/** Continue the delegate's most recent session. */
	continueLast?: boolean;
}

/**
 * Build the shell command for one delegate.
 *
 * The base64 payload is decoded by `base64 -d` (Git Bash ships coreutils) and handed
 * to the CLI through command substitution, so the task never passes through shell
 * quoting as literal text.
 */
export function buildDelegateCommand(options: DelegateCommandOptions): string {
	const quoted = (model: string) => buildArgv({ ...options, model });

	const withEffort = quoted(withDefaultEffort(options.model));
	const bare = withoutEffort(withDefaultEffort(options.model));
	if (bare === null) return withEffort;

	// Run the plain command, and retry without the variant only for the specific failure a
	// missing variant produces. Matching the error text keeps a genuine task failure from
	// being retried (which would double-charge the model and duplicate any side effects).
	//
	// The output MUST be replayed on the success path. An earlier version wrote
	// `out=$(CMD) || { ...retry-or-report... }` and never printed `$out` when the command
	// succeeded, so every successful delegate produced an empty stream: the job reached
	// `done` with exit 0 and a 0-byte output file, and the model was told "no text in the
	// delegate stream" while the delegate's side effects had already happened. Capture the
	// code, decide, then always emit.
	return (
		`out=$(${withEffort} 2>&1); rc=$?; ` +
		`if [ $rc -ne 0 ] && printf '%s' "$out" | grep -q 'Variant unavailable'; then ${quoted(bare)}; ` +
		`else printf '%s\\n' "$out"; exit $rc; fi`
	);
}

function buildArgv(options: DelegateCommandOptions): string[] {
	const encoded = encodeTask(withVerificationCovenant(options.task));
	const title = (options.title ?? "pi-async delegate").replace(/"/g, "");
	const parts = [
		quote(options.cli),
		"run",
		"--standalone",
		"--agent",
		quote(options.agent),
		"--auto",
		"--format",
		"json",
		"--model",
		quote(options.model),
		"--title",
		quote(title),
	];
	for (const file of options.files ?? []) {
		parts.push("--file", quote(file));
	}
	if (options.continueLast) parts.push("--continue");
	if (options.session) parts.push("--session", quote(options.session));
	parts.push(`"$(printf '%s' ${quote(encoded)} | base64 -d)"`);
	return parts.join(" ");
}

/**
 * Prepend the standing covenant every delegate gets.
 *
 * Why this exists: a delegate given a false premise in the task description will build
 * its whole report on it and sound just as confident. In one measured batch, two
 * delegates analysed a codebase feature that had been reverted months earlier because
 * the caller's description said it still existed; only a third that happened to grep for
 * the symbol noticed. Telling the delegate up front that the caller's description is
 * evidence, not fact, is the cheapest fix for that failure mode.
 *
 * Kept short on purpose - it is prepended to every task and must not crowd out the task.
 *
 * ⚠️ Kept byte-identical with `VERIFICATION_COVENANT` in `../opencode/index.ts`.
 * The two extensions load independently and are forbidden from importing each other,
 * so this is a deliberate duplicate - change both or they drift.
 */
export function withVerificationCovenant(task: string): string {
	const covenant = [
		"Four standing rules for this task:",
		"1. My description below is evidence, not fact. If what you read in the code",
		"   contradicts it, say so explicitly and follow the code.",
		"2. Mark anything you did not verify by reading actual code as UNVERIFIED.",
		"   Do not infer a file's contents from its name, or a symbol's behaviour from",
		"   the fact that it is referenced.",
		"3. Severity must state its basis. If you derived a cost from worst-case",
		"   theoretical complexity rather than from a measurement, say so on that line",
		"   (e.g. \"theoretical, unmeasured\"). Do not label such an item P0.",
		"   Measured numbers are worth far more than derived ones here.",
		"4. If you cannot verify something, say you could not - silence is not a claim",
		"   of correctness. Do not fill a gap with a plausible-sounding inference.",
	].join("\n");
	return `${covenant}\n\n---\n\n${task}`;
}

/**
 * Give every model the standing `high` reasoning effort unless one was asked for.
 *
 * OpenCode selects effort with a `#variant` suffix on the model id. Leaving it off lets the
 * provider pick, which in practice means shallow answers; adding it is one string operation.
 *
 * NOT every model HAS a `high` variant. This used to be applied unconditionally, with the
 * comment claiming the worst case was "a little latency" - it is not: the CLI rejects the
 * whole run with `provider.no-route: Variant unavailable for <model>: high`. Measured on
 * `opencode/nemotron-3-ultra-free`, which has no variants at all, so every delegate sent to
 * it failed instantly. Hence the fallback in `buildDelegateCommand` below.
 */
export function withDefaultEffort(model: string): string {
	return model.includes("#") ? model : `${model}#high`;
}

/**
 * The same command, minus the `#variant` suffix.
 *
 * Used as the `||` fallback so a model without a `high` variant still gets its task, at the
 * provider's default effort. Returns null when the model never had a suffix, so the caller
 * does not append a pointless duplicate attempt.
 */
export function withoutEffort(model: string): string | null {
	const hash = model.indexOf("#");
	return hash === -1 ? null : model.slice(0, hash);
}

function quote(value: string): string {
	// Double quotes keep Windows paths with spaces and backslashes usable in Git Bash.
	return `"${value.replace(/"/g, '\\"')}"`;
}

export interface DecodedDelegate {
	text: string;
	sessionID?: string;
	toolCalls: number;
	cost: number;
	error?: string;
	stopReason?: string;
	/** Per-tool call counts, e.g. {read: 14, grep: 8}. */
	toolBreakdown?: Record<string, number>;
	/** Files the delegate actually read, with the line count it consumed from each. */
	filesRead?: Array<{ path: string; lines: number }>;
	/** Total lines consumed across all reads. */
	linesRead?: number;
}

/**
 * Decode an opencode `--format json` JSONL stream.
 *
 * Event shape (verified against opencode 2.0.30):
 *   {"type":"text","part":{"text":"..."}}
 *   {"type":"tool_use","part":{"tool":"shell","state":{...}}}
 *   {"type":"step_finish","part":{"reason":"stop","cost":0,"tokens":{...}}}
 *   {"type":"error","error":{"type":"provider.quota","message":"...","status":402}}
 *
 * Only the last text event is the answer; earlier ones narrate the steps.
 *
 * Tool events carry `part.tool` and `part.state.input.path` / `part.state.output`, which is
 * how the caller learns WHAT was actually examined rather than only how many calls were
 * made. That distinction is the whole point: a delegate that reports on a 2762-line file
 * after reading 132 of its lines is a different risk from one that read all of it, and
 * only the event stream can tell the two apart - the delegate's own prose cannot, and
 * asking it to self-report confidence does not help because the number is not its to know.
 */
export function decodeDelegateStream(raw: string): DecodedDelegate {
	const texts: string[] = [];
	let sessionID: string | undefined;
	let toolCalls = 0;
	let cost = 0;
	let error: string | undefined;
	let stopReason: string | undefined;
	const breakdown: Record<string, number> = {};
	const perFile = new Map<string, number>();

	for (const line of raw.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed[0] !== "{") continue;
		let event: any;
		try {
			event = JSON.parse(trimmed);
		} catch {
			continue;
		}
		const part = event?.part;
		switch (event?.type) {
			case "text":
				if (typeof part?.text === "string" && part.text.length > 0) texts.push(part.text);
				break;
			case "tool_use": {
				toolCalls++;
				const toolName = typeof part?.tool === "string" ? part.tool : "other";
				breakdown[toolName] = (breakdown[toolName] ?? 0) + 1;
				// Only `read` tells us what was examined. The line span is parsed out of the
				// tool's own output ("Read file X, lines 1-52"), which is the ground truth for
				// how much of the file actually reached the model.
				if (toolName === "read") {
					const input = part?.state?.input;
					const path = typeof input?.path === "string" ? input.path : undefined;
					if (path) {
						const out = typeof part?.state?.output === "string" ? part.state.output : "";
						const span = out.match(/lines (\d+)-(\d+)/);
						const lines = span ? Math.max(0, Number(span[2]) - Number(span[1]) + 1) : 0;
						perFile.set(path, (perFile.get(path) ?? 0) + lines);
					}
				}
				break;
			}
			case "step_finish":
				if (typeof part?.reason === "string") stopReason = part.reason;
				if (typeof part?.cost === "number") cost += part.cost;
				break;
			case "error": {
				// The real message is nested under `error`, not `part`.
				const detail = event?.error ?? {};
				const message = detail.message ?? event?.message ?? part?.message;
				const kind = detail.type ?? part?.type;
				const status = typeof detail.status === "number" ? ` (HTTP ${detail.status})` : "";
				error = message ? `${kind ? `${kind}: ` : ""}${message}${status}` : "opencode reported an error";
				break;
			}
			default:
				break;
		}
		if (!sessionID && typeof event?.sessionID === "string") sessionID = event.sessionID;
	}

	return {
		text: texts.length > 0 ? texts[texts.length - 1] : "",
		sessionID,
		toolCalls,
		cost,
		error,
		stopReason,
		toolBreakdown: breakdown,
		filesRead: [...perFile.entries()]
			.map(([path, lines]) => ({ path, lines }))
			.sort((a, b) => b.lines - a.lines),
		linesRead: [...perFile.values()].reduce((sum, n) => sum + n, 0),
	};
}

/**
 * Read a finished delegate's stream and turn it into model-facing text.
 *
 * Reads from the job's output file when the engine kept one, so this works for
 * recovered jobs too.
 */
/**
 * The OpenCode channel's renderer, in the shape the framework's registry expects.
 *
 * Returning it as a value (rather than the caller reaching for a module function) is what
 * lets the framework stay ignorant of this channel: it stores whatever was registered
 * under the name, and never imports this file.
 */
export const openCodeChannel = {
	name: "opencode",
	digest(record: any): string {
		// The in-memory `output` of a delegate is a JSONL stream's tail cut at an arbitrary
		// byte, so its first line is a fragment and reads as garbage. Point at the real
		// result instead of showing noise.
		const calls = Number(record.stats?.toolCalls ?? 0);
		const suffix = calls > 0 ? `, ${String(calls)} tool calls` : "";
		return `${record.state}${suffix}  (delegate - use job_logs for the full result)`;
	},
	render(record: any, ctx: any): string {
		return renderDelegateResult(record, ctx, 6000);
	},
};

export function renderDelegateResult(
	record: any,
	ctx: { tailOutput: (id: string, maxBytes: number) => { text: string; totalBytes: number } },
	maxChars = 6000,
): string {
	// Read the output FILE first, never the in-memory tail.
	//
	// Measured defect this fixes: `record.output` is a 16KB in-memory tail chopped at an
	// arbitrary byte offset (engine.ts TAIL_BYTES). For a delegate the stream is JSONL, so
	// a tail that starts mid-line yields fragments that parse to nothing - the decode then
	// finds no text event and the whole result renders as "(no output)" even though the
	// file on disk holds everything. Observed on a 298KB stream that decoded to 34KB of
	// real answer while the UI showed nothing.
	//
	// The file is the source of truth (same rationale as engine.logs). The tail is only a
	// fallback for the window before the file is readable.
	let raw = "";
	const fromFile = ctx.tailOutput(record.id, 4 * 1024 * 1024);
	if (fromFile.totalBytes > 0) {
		raw = fromFile.text;
	}
	if (!raw) {
		raw = record.output ?? "";
	}
	const decoded = decodeDelegateStream(raw);
	// Channel-specific facts live in `record.stats`, a bag the framework never reads into.
	// They were named fields once, which meant the framework's own types knew that a
	// channel called OpenCode exists.
	const stats = (record.stats ??= {});
	if (decoded.sessionID) stats.sessionID = decoded.sessionID;
	if (decoded.cost) stats.cost = decoded.cost;
	stats.toolCalls = decoded.toolCalls;

	const failed = record.state !== "done";
	// Tool-call count is the only cheap proxy for "did it actually read the files it
	// claims to have read". It was being recorded but never shown, so a caller could not
	// tell a 2-call skim from a 60-call full pass and had to re-verify everything by hand.
	const effort = decoded.toolCalls > 0 ? `${decoded.toolCalls} tool calls` : "";
	const header = [
		`[OpenCode delegate ${record.id} ${failed ? record.state : "finished"}]`,
		record.finishedAt && record.startedAt ? `${Math.round((record.finishedAt - record.startedAt) / 1000)}s` : "",
		decoded.cost > 0 ? `$${decoded.cost.toFixed(4)}` : "free",
		effort,
		decoded.sessionID ? `session ${decoded.sessionID}` : "",
	]
		.filter(Boolean)
		.join(", ");

	const coverage = formatCoverage(decoded);

	// `detail` must never be empty: an empty string renders as a blank result and looks
	// identical to a delegate that said nothing. Always fall back to a sentence that says
	// WHAT was empty, so the caller can tell "no answer" from "decode failed".
	let detail: string;
	if (failed) {
		detail = record.error ?? decoded.error ?? "";
		if (!detail) detail = raw.trim().slice(0, 800) || "(failed, no output captured)";
	} else {
		detail = decoded.text;
		if (!detail) {
			detail =
				`(no text in the delegate stream: ${raw.length} bytes, ${decoded.toolCalls} tool calls, ` +
				`stop=${decoded.stopReason ?? "unknown"}) — open the job output file to see the raw event stream`;
		}
	}

	const body = detail.length > maxChars ? `${detail.slice(0, maxChars)}...` : detail;
	// Say CLEARLY when the answer is cut off. A silent "..." reads as "it ended there",
	// which is the one thing it does not mean - measured case: a 34312-char report whose
	// conclusion sat past the 6000-char cap while the header looked complete.
	const cut =
		detail.length > maxChars
			? `\n\n[TRUNCATED: showing first ${maxChars} of ${detail.length} chars - the conclusion may be beyond this. ` +
				`Full result: job_logs ${record.id}]`
			: "";
	return `${header}\n\nTask: ${record.summary.slice(0, 200)}\n\nResult:\n${body}${cut}${coverage}`;
}

/**
 * How much of what it claims to have examined it actually read.
 *
 * Derived from tool_use events, not from the delegate's prose. This is the one number in
 * the whole result that cannot be hallucinated: the CLI records the calls, the model does
 * not write them. A report on a 2762-line file produced from 132 read lines is a different
 * risk from one produced from all of it, and until now the caller had no way to tell.
 *
 * Deliberately terse - it rides on every delegate result.
 */
function formatCoverage(decoded: DecodedDelegate): string {
	const tools = decoded.toolBreakdown ?? {};
	const files = decoded.filesRead ?? [];
	// Never render an empty coverage block, and never let "no read calls" read as "examined
	// nothing". A delegate can work entirely through grep/bash and touch hundreds of files
	// without a single `read` - saying nothing there would be the same silent-empty mistake
	// this whole area was meant to fix.
	if (files.length === 0) {
		const toolLine = Object.entries(tools)
			.sort((a, b) => b[1] - a[1])
			.map(([name, n]) => `${name}×${n}`)
			.join(" ");
		if (!toolLine) return "";
		return `\n\n[examined: no \`read\` calls (file coverage unknown) | ${toolLine}]`;
	}
	const lines = decoded.linesRead ?? 0;
	const toolLine = Object.entries(tools)
		.sort((a, b) => b[1] - a[1])
		.map(([name, n]) => `${name}×${n}`)
		.join(" ");
	const top = files
		.slice(0, 5)
		.map((f) => `    ${f.lines} lines  ${f.path}`)
		.join("\n");
	const more = files.length > 5 ? `\n    ... and ${files.length - 5} more file(s)` : "";
	return `\n\n[examined: ${files.length} file(s), ${lines} lines total | ${toolLine}]\n${top}${more}`;
}

/** Enumerate the CLI's free-tier models. Falls back to an empty list on failure. */
export function listFreeModels(cli: string, timeoutMs = 30000): string[] {
	try {
		const out = execFileSync(cli, ["models"], { encoding: "utf8", timeout: timeoutMs, windowsHide: true });
		return out
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line.length > 0 && /free/i.test(line));
	} catch {
		return [];
	}
}

/** Read the CLI's model list without the free filter, for diagnostics. */
export function listAllModels(cli: string, timeoutMs = 30000): string[] {
	try {
		const out = execFileSync(cli, ["models"], { encoding: "utf8", timeout: timeoutMs, windowsHide: true });
		return out
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean);
	} catch {
		return [];
	}
}

/** Best-effort read of a file's contents for the `files` attachment list. */
export function readAttachment(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}
