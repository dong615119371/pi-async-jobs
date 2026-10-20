/**
 * opencode-delegate - the OpenCode delegate channel and the `delegate_async` tool.
 *
 * This package is a *consumer* of the async-jobs host. It does not import the host
 * package: Pi gives each extension its own module graph, so an imported `channels.ts`
 * would be a second copy with a second registry that the host's engine never reads.
 * Instead it asks over `pi.events` and holds the service object it gets back
 * (see ./consumer.ts).
 *
 * The channel renderer and the tool that produces such jobs are registered together, so
 * the two cannot drift apart: if this tool is registered, its reader is too. The host
 * only ever sees the name "opencode" as an opaque string.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { buildDelegateCommand, listFreeModels, openCodeChannel } from "./channel.ts";
import { connectToHost } from "./consumer.ts";
import { findOpencodeCli } from "./cli.ts";

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

const DELEGATE_TIMEOUT_SECONDS = 30 * 60;
// Reasoning effort is appended to the model id as an OpenCode `#variant` suffix. `high` is
// the standing default: a higher effort only costs latency, while a lower one produces
// shallow output, so the safe direction to be wrong in is upwards.
const DEFAULT_MODEL = "opencode/deepseek-v4.1-flash-free#high";
const DEFAULT_AGENT = "build";
const AGENTS = ["build", "plan", "explore", "general"] as const;
const PREVIEW_CHARS = 1200;

function preview(text: string, max = PREVIEW_CHARS): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}...`;
}

/**
 * Register the async delegate tool, leaving it inactive.
 *
 * Activation is the caller's decision: `delegate_async` only makes sense when the
 * async-jobs host is actually present. An entry point that cannot see the host leaves
 * the tool registered but dormant, so installing this package alone still yields a
 * working synchronous `opencode` tool and nothing broken.
 *
 * Returns an `activate` function that registers the renderer and puts the tool into the
 * active set. It is safe to call repeatedly.
 */
export function registerDelegateTool(pi: any): () => boolean {
	const host = connectToHost(pi);
	let svc: any = null;

	/**
	 * The host service, fetched lazily.
	 *
	 * The service travels over `pi.events` and may not have arrived yet when this factory
	 * runs, so the accessor is asked for it on demand rather than captured once.
	 */
	const getService = () => {
		if (!svc) svc = host.service();
		return svc;
	};

	/**
	 * Register this package's channel renderer with the host.
	 *
	 * The host's `registerChannel` replaces by name, so calling it again once the service
	 * shows up is safe - and needed, because the service can arrive after session_start.
	 */
	const ensureChannel = () => {
		const current = getService();
		if (!current) return;
		current.registerChannel(openCodeChannel);
	};

	pi.on("session_start", ensureChannel);

	// ------------------------------------------------------- opencode delegate

	// The channel's renderer is registered alongside the tool that produces such jobs, so
	// the two cannot drift apart: if this tool is registered, its reader is too. The
	// framework only ever sees the name "opencode" as an opaque string.
	ensureChannel();

	pi.registerTool({
		...TOOL_DEFAULTS,
		name: "delegate_async",
		label: "Delegate (background)",
		description: [
			"Hand work to OpenCode's free-tier models and return immediately.",
			"Use it for legwork - bulk edits, mechanical refactors, repetitive changes, long grunt work - not for decisions.",
			"Keep the thinking here and outsource the doing: the delegate has its own context and cannot see this conversation.",
			"Only free models are accepted (default \"opencode/deepseek-v4.1-flash-free\"); the list is read from the CLI at runtime.",
			"IMPORTANT: OpenCode ignores the working directory and runs in your home directory, so every path in a task must be absolute.",
			"Results arrive as messages; do not poll for them.",
			"Use this only when you have other work to do meanwhile.",
			"If the next step needs this result there is no async answer: either do that next step yourself, or ask the user to shut async mode off (/async off), which brings back the blocking `opencode` tool.",
			"Do not split one wait into two: starting a job and then idling until it lands costs a round trip and buys nothing.",
		].join(" "),
		parameters: Type.Object({
			tasks: Type.Array(
				Type.Object({
					task: Type.String({ description: "Self-contained task with absolute paths" }),
					model: Type.Optional(Type.String({ description: "Free model id for this task" })),
					agent: Type.Optional(Type.String({ description: `OpenCode agent: ${AGENTS.join(" | ")}` })),
				}),
				{ description: "Tasks to start in the background" },
			),
			model: Type.Optional(Type.String({ description: `Default free model. Default "${DEFAULT_MODEL}"` })),
			agent: Type.Optional(Type.String({ description: `Default agent. Default "${DEFAULT_AGENT}"` })),
			timeoutSeconds: Type.Optional(Type.Number({ description: `Per-task timeout. Default ${DELEGATE_TIMEOUT_SECONDS}.` })),
			files: Type.Optional(
				Type.Array(Type.String(), { description: "Files to attach to every task (absolute paths)" }),
			),
			session: Type.Optional(
				Type.String({ description: "OpenCode session id to reuse, keeping the delegate's context across calls." }),
			),
			continue: Type.Optional(
				Type.Boolean({ description: "Continue the delegate's most recent session. Default: false." }),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			if (params.tasks.length === 0) {
				return { content: [{ type: "text", text: "Provide at least one task." }], details: undefined };
			}
			// The host service may not have answered yet; the renderer has to be registered
			// before the job it is going to render settles.
			ensureChannel();
			if (!getService()) {
				return {
					content: [
						{
							type: "text",
							text: "The async-jobs host service is not available yet. Try again in a moment.",
						},
					],
					details: undefined,
				};
			}
			const cli = findOpencodeCli();
			if (!cli) {
				return {
					content: [{ type: "text", text: "OpenCode CLI not found. Install the desktop client or set OPENCODE_CLI." }],
					details: undefined,
				};
			}

			const freeModels = listFreeModels(cli);
			const defaultModel = params.model ?? DEFAULT_MODEL;
			const defaultAgent = params.agent ?? DEFAULT_AGENT;

			const requested = [defaultModel, ...params.tasks.map((t) => t.model)].filter(
				(m): m is string => typeof m === "string" && m.length > 0,
			);
			// A model id may carry a `#variant` suffix (e.g. ...free#high) that selects the
			// reasoning effort. The free-model list contains bare ids only, so compare on the
			// part before the hash - otherwise every variant request is refused as "not free".
			const rejected = requested.filter((m) => !freeModels.includes(m.split("#")[0] ?? m));
			if (rejected.length > 0) {
				return {
					content: [
						{
							type: "text",
							text:
								`Refused: not a free model: ${rejected.join(", ")}.\n` +
								`Available free models:\n  ${freeModels.join("\n  ") || "(none found - is the OpenCode client logged in?)"}`,
						},
					],
					details: undefined,
				};
			}

			const agents = [defaultAgent, ...params.tasks.map((t) => t.agent)].filter(
				(a): a is string => typeof a === "string" && a.length > 0,
			);
			const badAgent = agents.find((a) => !(AGENTS as readonly string[]).includes(a));
			if (badAgent) {
				return {
					content: [{ type: "text", text: `Unknown agent "${badAgent}". Available: ${AGENTS.join(", ")}.` }],
					details: undefined,
				};
			}

			const started: Array<{ id: string; task: string }> = [];
			for (const item of params.tasks) {
				try {
					const handle = svc.startProcess({
						command: buildDelegateCommand({
							cli,
							task: item.task,
							model: item.model ?? defaultModel,
							agent: item.agent ?? defaultAgent,
							title: "pi-async delegate",
							files: params.files,
							session: params.session,
							continueLast: params.continue,
						}),
						name: `delegate: ${item.task.slice(0, 60)}`,
						kind: "delegate",
						channel: "opencode",
						timeoutSeconds: params.timeoutSeconds ?? DELEGATE_TIMEOUT_SECONDS,
					});
					started.push({ id: handle.id, task: item.task });
				} catch (error) {
					return {
						content: [
							{
								type: "text",
								text: `Started ${started.length} job(s), then failed: ${error instanceof Error ? error.message : String(error)}`,
							},
						],
						details: { jobs: started },
					};
				}
			}

			const lines = started.map((s) => `  ${s.id}  ${preview(s.task, 100)}`);
			return {
				content: [
					{
						type: "text",
						text:
							`Started ${started.length} delegate job(s). This call has already returned - it did NOT block.\n` +
							`What to do now: carry on with your own work, or end your turn. ` +
							`You will be notified as each finishes - no action needed on your part.\n` +
							`Do not poll. Job ids:\n${lines.join("\n")}\n\n` +
							`Note that OpenCode runs in your home directory, so tasks must use absolute paths.`,
					},
				],
				details: { jobs: started },
			};
		},

		renderCall(args, theme, _context) {
			const tasks = args.tasks ?? [];
			let text = `${theme.fg("toolTitle", theme.bold("delegate_async "))}${theme.fg("accent", `x${tasks.length}`)}`;
			for (const t of tasks.slice(0, 3)) text += `\n  ${theme.fg("dim", preview(t.task, 60))}`;
			if (tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${tasks.length - 3} more`)}`;
			return new Text(text, 0, 0);
		},
		renderResult(result, _opts, theme, _context) {
			const first = result.content[0];
			return new Text(theme.fg("toolOutput", first?.type === "text" ? first.text : ""), 0, 0);
		},
	});

	/**
	 * Turn the tool on, if the host is there.
	 *
	 * Two things happen together: the renderer is registered (so results from this
	 * channel render as delegate output rather than raw JSONL) and the tool joins the
	 * active set. Doing one without the other would give either a tool whose results
	 * arrive as garbage or a renderer nobody can reach.
	 *
	 * Returns false when no host is present, which is not an error - it just means this
	 * package is running standalone.
	 */
	return () => {
		const current = getService();
		if (!current) return false;
		current.registerChannel(openCodeChannel);
		const active = new Set(pi.getActiveTools());
		active.add("delegate_async");
		pi.setActiveTools([...active]);
		return true;
	};
}
