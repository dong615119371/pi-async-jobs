/**
 * pi-delegate - outsource work to the OpenCode CLI.
 *
 * Two tools, one package, and the second one is conditional:
 *
 *   `opencode`        synchronous, always available. Blocks until the work is done,
 *                     because the next step needs the answer.
 *   `delegate_async`  asynchronous, only when the async-jobs host is installed. Fires
 *                     the job and returns a job id; the result arrives later.
 *
 * The conditional half is why this package talks to the host over `pi.events` instead
 * of importing it: Pi gives each extension its own module graph, so an imported
 * registry would be a second copy the host's engine never reads. See ./consumer.ts.
 *
 * Installed alone this is a working synchronous delegation tool and nothing else.
 * Installed alongside async-jobs, the async half switches itself on.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { findOpencodeCli, runOpencode, type OpenCodeRunResult } from "./cli.ts";
import { getFreeModels, resetFreeModels } from "./models.ts";
import { registerDelegateTool } from "./delegate.ts";

const DEFAULT_MODEL = "opencode/deepseek-v4.1-flash-free";
const DEFAULT_AGENT = "build";
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_PARALLEL_TASKS = 6;
const MAX_CONCURRENCY = 3;
const PER_TASK_OUTPUT_CAP = 50 * 1024;

/** Agents exposed by opencode v2.0.30 (`opencode debug agents`). */
const AGENTS = ["build", "plan", "explore", "general"] as const;

/**
 * The standing instructions every delegate receives, prepended to its task.
 *
 * Measured reason it exists: a batch of delegates handed a task description that
 * carried a stale fact about the codebase built their entire report on it, and
 * said so just as confidently as the ones that were right. Only the delegate that
 * happened to grep for the symbol caught it. The caller's description is evidence,
 * not ground truth, and saying so costs two sentences.
 */
const VERIFICATION_COVENANT = [
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
	"",
	"---",
	"",
].join("\n");

interface DelegateDetails {
	mode: "single" | "parallel" | "chain";
	models: string[];
	freeModels: string[];
	results: OpenCodeRunResult[];
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}

/**
 * How much of what it claims to have examined it actually read.
 *
 * Derived from the recorded `read` calls, not from the delegate's prose - the line span is
 * parsed out of the tool's own output, so unlike a self-reported confidence score it cannot
 * be hallucinated. A report on a 2762-line file produced from 132 read lines is a different
 * risk from one produced from all of it, and without this the caller cannot tell.
 *
 * Mirrors formatCoverage() in `../async-jobs/opencode-channel.ts`; the two extensions load
 * independently, so this is a deliberate duplicate - change both.
 */
function formatCoverage(result: OpenCodeRunResult): string {
	const perFile = new Map<string, number>();
	const breakdown: Record<string, number> = {};
	for (const call of result.toolCalls) {
		const name = call.tool || "other";
		breakdown[name] = (breakdown[name] ?? 0) + 1;
		if (name !== "read") continue;
		const input = call.input as { path?: unknown } | undefined;
		const path = typeof input?.path === "string" ? input.path : undefined;
		if (!path) continue;
		const span = (call.output ?? "").match(/lines (\d+)-(\d+)/);
		const lines = span ? Math.max(0, Number(span[2]) - Number(span[1]) + 1) : 0;
		perFile.set(path, (perFile.get(path) ?? 0) + lines);
	}
	if (perFile.size === 0) {
		const toolLine = Object.entries(breakdown)
			.sort((a, b) => b[1] - a[1])
			.map(([n, c]) => `${n}×${c}`)
			.join(" ");
		if (!toolLine) return "";
		return `\n[examined: no \`read\` calls (file coverage unknown) | ${toolLine}]`;
	}
	const files = [...perFile.entries()].map(([path, lines]) => ({ path, lines })).sort((a, b) => b.lines - a.lines);
	const total = files.reduce((sum, f) => sum + f.lines, 0);
	const toolLine = Object.entries(breakdown)
		.sort((a, b) => b[1] - a[1])
		.map(([n, c]) => `${n}×${c}`)
		.join(" ");
	const top = files
		.slice(0, 5)
		.map((f) => `  ${f.lines} lines  ${f.path}`)
		.join("\n");
	const more = files.length > 5 ? `\n  ... and ${files.length - 5} more file(s)` : "";
	return `\n[examined: ${files.length} file(s), ${total} lines total | ${toolLine}]\n${top}${more}`;
}

function formatUsage(usage: OpenCodeRunResult["usage"], model: string): string {
	const parts: string[] = [];
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.reasoning) parts.push(`thinking:${formatTokens(usage.reasoning)}`);
	// The `plan` and `explore` agents emit only a `text` event, without the
	// step_finish that carries tokens, so no counts is a normal outcome rather
	// than a parse failure. Cost is what actually matters here.
	parts.push(usage.cost > 0 ? `$${usage.cost.toFixed(4)}` : "free");
	if (model) parts.push(model);
	return parts.join(" ");
}

function isFailed(result: OpenCodeRunResult): boolean {
	return (
		result.exitCode !== 0 ||
		result.aborted === true ||
		result.timedOut === true ||
		result.errorMessage !== undefined
	);
}

function getOutput(result: OpenCodeRunResult): string {
	if (result.aborted) return "(aborted)";
	if (result.timedOut) return "(timed out)";
	if (result.errorMessage) return result.errorMessage;
	if (result.exitCode !== 0) return result.stderr.trim() || `(exited with code ${result.exitCode})`;
	return result.text || "(no output)";
}

function truncateOutput(output: string): string {
	const bytes = Buffer.byteLength(output, "utf8");
	if (bytes <= PER_TASK_OUTPUT_CAP) return output;
	let cut = output.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(cut, "utf8") > PER_TASK_OUTPUT_CAP) cut = cut.slice(0, -1);
	return `${cut}\n\n[Output truncated: ${bytes - Buffer.byteLength(cut, "utf8")} bytes omitted.]`;
}

async function mapWithConcurrency<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let next = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		for (;;) {
			const index = next++;
			if (index >= items.length) return;
			results[index] = await fn(items[index], index);
		}
	});
	await Promise.all(workers);
	return results;
}

/** Free-model list, resolved once per process via the shared cache in models.ts. */
function getFreeModelsFor(_cli: string): Promise<string[]> {
	return getFreeModels();
}

const TaskItem = Type.Object({
	task: Type.String({ description: "Task to delegate to the OpenCode delegate" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for this task" })),
	model: Type.Optional(
		Type.String({ description: "Free model id for this task, e.g. 'opencode/nemotron-3-ultra-free'" }),
	),
});

const ChainItem = Type.Object({
	task: Type.String({ description: "Task with an optional {previous} placeholder for the prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for this step" })),
	model: Type.Optional(Type.String({ description: "Free model id for this step" })),
});

const OpencodeParams = Type.Object({
	task: Type.Optional(Type.String({ description: "Task to delegate (single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Tasks to run in parallel" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Steps to run in sequence, {previous} carries output forward" })),
	model: Type.Optional(
		Type.String({
			description: `Free model id. Default "${DEFAULT_MODEL}". Only ids carrying a 'free' label are accepted.`,
		}),
	),
	agent: Type.Optional(
		Type.String({
			description:
				`OpenCode agent: ${AGENTS.join(" | ")}. Default "${DEFAULT_AGENT}" (can write files and run shell). ` +
				'Use "plan" for a read-only delegate.',
		}),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory (single mode, or the default for every task)" })),
	session: Type.Optional(
		Type.String({ description: "OpenCode session id. Reusing one keeps the delegate's context across calls." }),
	),
	continue: Type.Optional(Type.Boolean({ description: "Continue the delegate's last session. Default: false." })),
	files: Type.Optional(
		Type.Array(Type.String(), { description: "Files to attach to the task (paths are resolved from cwd)." }),
	),
	timeoutMs: Type.Optional(
		Type.Number({ description: `Timeout per task in milliseconds. Default ${DEFAULT_TIMEOUT_MS}.` }),
	),
});


export default function (pi: ExtensionAPI) {
	// Delegation is one level deep. Without a guard a delegate could delegate again, and
	// again, and the task would migrate outward forever and never come back.
	//
	// That recursion guard is not written here, because the two halves need different
	// answers. The async half is already safe: a headless process never receives the host
	// service, so `activate()` returns false and `delegate_async` stays dormant.
	//
	// The synchronous tool is the opposite case. `opencode` blocks and returns inside the
	// same turn, so a headless caller that waits for a result is exactly what it serves -
	// refusing it there would remove the only shape that makes sense without a user
	// watching. So it is registered unconditionally.

	pi.registerTool({
		name: "opencode",
		label: "OpenCode",
		description: [
			"Delegate execution to the OpenCode CLI running a free-tier model.",
			"Use this to hand off legwork - bulk edits, mechanical refactors, repetitive file changes, long grunt work -",
			"not to make decisions. Keep the thinking here and outsource the doing.",
			"Modes: single (task), parallel (tasks array), chain (steps with {previous}).",
			`Only free models are allowed (default "${DEFAULT_MODEL}"); the accepted list is read from the CLI.`,
			`Default agent is "${DEFAULT_AGENT}", which can write files and run shell commands. Pass agent:"plan" for read-only work.`,
			"IMPORTANT: OpenCode ignores the process working directory and runs in the user's home directory,",
			"so every path inside a task must be absolute. Relative paths will silently point at the wrong place.",
			"This call BLOCKS until the work is done, so the result is available within the same turn.",
			"Use it when the next step needs that result - dependent work such as change -> test -> read -> change.",
			"When you have other work to do meanwhile, async delegation is the better shape.",
			"(That is `delegate_async`, offered by this same package when the async-jobs host is installed. It fires the job and returns immediately. Pick sync only when you must wait anyway.)",
		].join(" "),
		parameters: OpencodeParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const cli = findOpencodeCli();
			if (!cli) {
				return {
					content: [
						{
							type: "text",
							text:
								"OpenCode CLI not found. Install the OpenCode desktop client, or set OPENCODE_CLI to the " +
								"opencode-cli executable.",
						},
					],
					details: undefined,
				};
			}

			const agent = params.agent ?? DEFAULT_AGENT;
			if (!(AGENTS as readonly string[]).includes(agent)) {
				return {
					content: [{ type: "text", text: `Unknown agent "${agent}". Available: ${AGENTS.join(", ")}.` }],
					details: undefined,
				};
			}

			const freeModels = await getFreeModelsFor(cli);

			// Enforce the free-only policy before spawning anything.
			const requested = [params.model, ...(params.tasks ?? []).map((t) => t.model), ...(params.chain ?? []).map((s) => s.model)]
				.filter((m): m is string => typeof m === "string" && m.length > 0);
			const rejected = requested.filter((m) => !freeModels.includes(m.split("#")[0] ?? m));
			if (rejected.length > 0) {
				const list = freeModels.length > 0 ? freeModels.join("\n  ") : "(could not read the model list)";
				return {
					content: [
						{
							type: "text",
							text:
								`Refused: not a free model: ${rejected.join(", ")}.\n` +
								`Only free-tier models may be used. Available free models:\n  ${list}`,
						},
					],
					details: undefined,
				};
			}

			const model = params.model ?? DEFAULT_MODEL;
			const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
			const baseCwd = params.cwd ?? ctx.cwd;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = typeof params.task === "string" && params.task.length > 0;
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);
			const mode: DelegateDetails["mode"] = hasChain ? "chain" : hasTasks ? "parallel" : "single";

			const makeDetails = (results: OpenCodeRunResult[]): DelegateDetails => ({
				mode,
				models: [model],
				freeModels,
				results,
			});

			const run = (task: string, cwd: string | undefined, override: string | undefined) =>
				runOpencode({
					cli,
					agent,
					model: override ?? model,
					task: VERIFICATION_COVENANT + task,
					cwd: cwd ?? baseCwd,
					session: params.session,
					continueLast: params.continue,
					files: params.files,
					// Tag every delegate session so the durable record it leaves is
					// identifiable in `session list` instead of "Untitled session".
					title: "pi-delegate (sync)",
					timeoutMs,
					signal,
				});

			if (modeCount !== 1) {
				return {
					content: [
						{
							type: "text",
							text: `Provide exactly one mode: task, tasks, or chain.\nFree models: ${freeModels.join(", ") || "none"}`,
						},
					],
					details: makeDetails([]),
				};
			}

			if (hasChain) {
				const results: OpenCodeRunResult[] = [];
				let previous = "";

				for (let i = 0; i < params.chain!.length; i++) {
					const step = params.chain![i];
					const task = step.task.replace(/\{previous\}/g, previous);

					onUpdate?.({
						content: [{ type: "text", text: `Step ${i + 1}/${params.chain!.length}: running...` }],
						details: makeDetails(results),
					});

					const result = await run(task, step.cwd, step.model);
					results.push(result);

					if (isFailed(result)) {
						return {
							content: [{ type: "text", text: `Chain stopped at step ${i + 1}: ${getOutput(result)}` }],
							details: makeDetails(results),
							isError: true,
						};
					}
					previous = result.text;
				}

				const last = results[results.length - 1];
				return {
					content: [{ type: "text", text: last.text || "(no output)" }],
					details: makeDetails(results),
				};
			}

			if (hasTasks) {
				if (params.tasks!.length > MAX_PARALLEL_TASKS) {
					return {
						content: [
							{ type: "text", text: `Too many parallel tasks (${params.tasks!.length}). Max is ${MAX_PARALLEL_TASKS}.` },
						],
						details: makeDetails([]),
					};
				}

				const slots: OpenCodeRunResult[] = params.tasks!.map((t) => ({
					agent,
					model: t.model ?? model,
					task: t.task,
					exitCode: -1,
					text: "",
					toolCalls: [],
					usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
					stderr: "",
				}));

				let done = 0;
				const emit = () =>
					onUpdate?.({
						content: [{ type: "text", text: `Parallel: ${done}/${slots.length} done...` }],
						details: makeDetails([...slots]),
					});

				const results = await mapWithConcurrency(params.tasks!, MAX_CONCURRENCY, async (t, index) => {
					const result = await run(t.task, t.cwd, t.model);
					slots[index] = result;
					done++;
					emit();
					return result;
				});

				const ok = results.filter((r) => !isFailed(r)).length;
				const summaries = results.map((r) => {
					const status = isFailed(r) ? "failed" : "completed";
					return `### [${status}] ${r.task}\n\n${truncateOutput(getOutput(r))}`;
				});

				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${ok}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
						},
					],
					details: makeDetails(results),
				};
			}

			const result = await run(params.task!, undefined, undefined);
			if (isFailed(result)) {
				return {
					content: [{ type: "text", text: `OpenCode delegate failed: ${getOutput(result)}` }],
					details: makeDetails([result]),
					isError: true,
				};
			}
			return {
				content: [{ type: "text", text: result.text || "(no output)" }],
				details: makeDetails([result]),
			};
		},

		renderCall(args, theme, _context) {
			const agent = args.agent ?? DEFAULT_AGENT;
			const model = args.model ?? DEFAULT_MODEL;
			const header =
				theme.fg("toolTitle", theme.bold("opencode ")) +
				theme.fg("accent", agent) +
				theme.fg("dim", ` ${model}`);

			if (args.chain && args.chain.length > 0) {
				let text = header + theme.fg("muted", ` chain (${args.chain.length} steps)`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const task = args.chain[i].task.replace(/\{previous\}/g, "").trim();
					text += `\n  ${theme.fg("muted", `${i + 1}.`)} ${theme.fg("dim", task.length > 50 ? `${task.slice(0, 50)}...` : task)}`;
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}

			if (args.tasks && args.tasks.length > 0) {
				let text = header + theme.fg("muted", ` parallel (${args.tasks.length} tasks)`);
				for (const t of args.tasks.slice(0, 3)) {
					text += `\n  ${theme.fg("dim", t.task.length > 50 ? `${t.task.slice(0, 50)}...` : t.task)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}

			const preview = args.task ? (args.task.length > 80 ? `${args.task.slice(0, 80)}...` : args.task) : "...";
			return new Text(`${header}\n  ${theme.fg("dim", preview)}`, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as DelegateDetails | undefined;
			if (!details || details.results.length === 0) {
				const first = result.content[0];
				return new Text(first?.type === "text" ? first.text : "(no output)", 0, 0);
			}

			const header = (r: OpenCodeRunResult) => {
				const icon = isFailed(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const tools = r.toolCalls.length > 0 ? theme.fg("muted", ` ${r.toolCalls.length} tool calls`) : "";
				return `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))} ${theme.fg("dim", formatUsage(r.usage, r.model))}${tools}`;
			};

			const body = (r: OpenCodeRunResult) => {
				const output = getOutput(r) + formatCoverage(r);
				if (expanded) {
					const toolLines = r.toolCalls
						.map((t) => `  ${theme.fg("muted", "→ ")}${theme.fg("accent", t.tool)}${t.status ? theme.fg("dim", ` ${t.status}`) : ""}`)
						.join("\n");
					return toolLines ? `${toolLines}\n\n${output}` : output;
				}
				const lines = output.split("\n");
				return lines.length > 12 ? `${lines.slice(0, 12).join("\n")}\n${theme.fg("muted", "(Ctrl+O to expand)")}` : output;
			};

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				return new Text(`${header(r)}\n${theme.fg("toolOutput", body(r))}`, 0, 0);
			}

			let text = `${theme.fg("toolTitle", theme.bold(`${details.mode} `))}${theme.fg("accent", `${details.results.filter((r) => !isFailed(r)).length}/${details.results.length}`)}`;
			for (const r of details.results) {
				text += `\n\n${header(r)}\n${theme.fg("toolOutput", body(r))}`;
			}
			const total = details.results.reduce((sum, r) => sum + r.usage.cost, 0);
			text += `\n\n${theme.fg("dim", `total ${total > 0 ? `$${total.toFixed(4)}` : "free"}`)}`;
			return new Text(text, 0, 0);
		},
	});

	// Asynchronous delegation lives in the `async-jobs` extension.
	//
	// It used to be registered here too (`delegate_background` / `delegate_status`), which
	// meant two competing implementations of the same idea: the model had to choose
	// between near-identical tools, and each kept its own concurrency budget, so the
	// real ceiling was the sum of both. That path is archived in
	// `~/.pi/agent/opencode-async-backup-*/background.ts`.
	//
	// What stays here is only what async-jobs does NOT provide: the synchronous
	// `opencode` tool, which blocks and returns its result inside the same turn. That is
	// the right shape for dependent work (change -> test -> read -> change), where
	// waiting is unavoidable because the next step needs the answer.


	// Reset the cached free-model list on reload so an OpenCode upgrade is picked
	// up without restarting Pi. In-flight background delegates keep running: they
	// represent the user's live work and a reload must not discard them.

	// The async half is registered but left inactive. Whether it ever becomes usable
	// depends on the host showing up, which is not knowable at factory time.
	const activateAsync = registerDelegateTool(pi);

	// Two chances to notice the host, because the two packages can load in either order:
	//   - `session_start`: every factory has returned, so a host that loaded first has
	//     already published its service.
	//   - the host announcing itself: covers a host that loads after this extension.
	const tryActivate = () => {
		activateAsync();
	};

	pi.on("session_start", tryActivate);
	pi.events.on("async-jobs:host-ready", tryActivate);

	// Reset the cached free-model list on reload so an OpenCode upgrade is picked up
	// without restarting Pi.
	pi.on("session_start", () => {
		resetFreeModels();
	});
}
