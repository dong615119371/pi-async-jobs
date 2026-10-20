/**
 * OpenCode CLI bridge.
 *
 * Discovers the CLI shipped with the OpenCode desktop client, lists its models,
 * and runs one headless invocation while parsing the `--format json` JSONL
 * event stream into a compact result.
 *
 * Verified against opencode v2.0.30 (`run --format json`):
 *   {"type":"step_start", ...}
 *   {"type":"text", "part":{"text":"PONG"}}
 *   {"type":"tool_use","part":{"tool":"shell","state":{"status":"completed","output":"..."}}}
 *   {"type":"step_finish","part":{"reason":"stop","cost":0,"tokens":{...}}}
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export interface Usage {
	input: number;
	output: number;
	reasoning: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export interface ToolCallRecord {
	tool: string;
	title?: string;
	status?: string;
	input?: unknown;
	output?: string;
}

export interface OpenCodeRunResult {
	agent: string;
	model: string;
	task: string;
	exitCode: number;
	text: string;
	toolCalls: ToolCallRecord[];
	usage: Usage;
	sessionID?: string;
	stopReason?: string;
	stderr: string;
	errorMessage?: string;
	aborted?: boolean;
	timedOut?: boolean;
}

const CLI_BASENAME = process.platform === "win32" ? "opencode-cli.exe" : "opencode-cli";

/**
 * Locate the CLI bundled with the desktop client.
 *
 * Order matters: the `resources` copy under LOCALAPPDATA is version-independent,
 * while the APPDATA `cli/<version>-<arch>` copies move on every upgrade. Prefer
 * the stable one and fall back to the newest versioned directory.
 */
export function findOpencodeCli(): string | null {
	const candidates: string[] = [];

	if (process.env.OPENCODE_CLI) candidates.push(process.env.OPENCODE_CLI);

	const local = process.env.LOCALAPPDATA;
	if (local) candidates.push(path.join(local, "Programs", "@opencodedesktop", "resources", CLI_BASENAME));

	const roaming = process.env.APPDATA;
	if (roaming) {
		const cliRoot = path.join(roaming, "ai.opencode.desktop", "cli");
		try {
			const dirs = fs.readdirSync(cliRoot).sort().reverse();
			for (const dir of dirs) candidates.push(path.join(cliRoot, dir, CLI_BASENAME));
		} catch {
			/* no versioned install; the other candidates may still resolve */
		}
	}

	candidates.push(CLI_BASENAME, "opencode");

	for (const candidate of candidates) {
		try {
			if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
		} catch {
			/* unreadable candidate: try the next one */
		}
	}
	return null;
}

/** List every model id the CLI reports, e.g. `opencode/deepseek-v4.1-flash-free`. */
export function listModels(cli: string): Promise<string[]> {
	return new Promise((resolve) => {
		let out = "";
		let settled = false;
		const finish = (value: string[]) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(value);
		};
		const timer = setTimeout(() => {
			try {
				proc.kill("SIGKILL");
			} catch {
				/* already gone */
			}
			finish(out ? parseLines(out) : []);
		}, 30_000);

		let proc: ReturnType<typeof spawn>;
		try {
			proc = spawn(cli, ["models"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
		} catch {
			finish([]);
			return;
		}
		proc.stdout?.on("data", (data) => {
			out += data.toString();
		});
		proc.on("error", () => finish([]));
		proc.on("close", () => finish(parseLines(out)));
	});
}

function parseLines(out: string): string[] {
	return out
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
}

/**
 * OpenCode session management.
 *
 * STATUS: these have no caller today. They were reached through the old
 * `background.ts` async delegate implementation, which was removed when the async
 * tools moved to the `async-jobs` extension. `listSessions` and `exportSession` were
 * never called even then (they were only re-exported); `deleteSessions` was.
 *
 * They are deliberately kept rather than deleted: this is the ONLY implementation of
 * OpenCode session list/export/delete in the tree. Every `run` invocation leaves a
 * durable session behind (the CLI has no `--no-session`), and nothing currently cleans
 * them up - `async-jobs` cleans up JOB records, not OpenCode sessions. Dropping these
 * would mean rewriting ~100 lines the day someone decides delegates need session
 * hygiene.
 *
 * IMPORTANT: keeping them does NOT mean this plugin is managing sessions. It is not.
 * Nothing here runs on its own.
 */
export interface SessionInfo {
	id: string;
	title: string;
	directory: string;
	created: number;
	updated: number;
	projectId?: string;
}

/**
 * Sessions opencode has persisted for a directory.
 *
 * Sessions are never optional: `run` has no `--no-session` flag, so every delegate
 * invocation leaves a durable record. This is how those records are inspected.
 */
export function listSessions(cli: string, cwd: string, max = 50): Promise<SessionInfo[]> {
	return new Promise((resolve) => {
		let out = "";
		let settled = false;
		const finish = (value: SessionInfo[]) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(value);
		};
		const timer = setTimeout(() => {
			try {
				proc.kill("SIGKILL");
			} catch {
				/* already gone */
			}
			finish([]);
		}, 30_000);

		let proc: ReturnType<typeof spawn>;
		try {
			proc = spawn(cli, ["session", "list", "--format", "json", "-n", String(max)], {
				cwd,
				shell: false,
				stdio: ["ignore", "pipe", "ignore"],
				windowsHide: true,
			});
		} catch {
			finish([]);
			return;
		}
		proc.stdout?.on("data", (data) => {
			out += data.toString();
		});
		proc.on("error", () => finish([]));
		proc.on("close", () => {
			try {
				const parsed = JSON.parse(out.trim());
				finish(Array.isArray(parsed) ? (parsed as SessionInfo[]) : []);
			} catch {
				finish([]);
			}
		});
	});
}

/** Full transcript of one session, including per-session token and cost totals. */
export function exportSession(cli: string, cwd: string, sessionID: string): Promise<any | null> {
	return new Promise((resolve) => {
		let out = "";
		let settled = false;
		const finish = (value: any | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(value);
		};
		const timer = setTimeout(() => {
			try {
				proc.kill("SIGKILL");
			} catch {
				/* already gone */
			}
			finish(null);
		}, 30_000);

		let proc: ReturnType<typeof spawn>;
		try {
			proc = spawn(cli, ["session", "export", sessionID], {
				cwd,
				shell: false,
				stdio: ["ignore", "pipe", "ignore"],
				windowsHide: true,
			});
		} catch {
			finish(null);
			return;
		}
		proc.stdout?.on("data", (data) => {
			out += data.toString();
		});
		proc.on("error", () => finish(null));
		proc.on("close", () => {
			try {
				finish(JSON.parse(out.trim()));
			} catch {
				finish(null);
			}
		});
	});
}

/** Delete a session and its children. Used to clean up delegate residue. */
export async function deleteSessions(cli: string, cwd: string, ids: string[]): Promise<{ deleted: string[]; failed: string[] }> {
	const deleted: string[] = [];
	const failed: string[] = [];
	// `session delete` accepts exactly one id, so loop instead of passing them together.
	for (const id of ids) {
		const ok = await new Promise<boolean>((resolve) => {
			let proc: ReturnType<typeof spawn>;
			try {
				proc = spawn(cli, ["session", "delete", id], { cwd, shell: false, stdio: "ignore", windowsHide: true });
			} catch {
				resolve(false);
				return;
			}
			proc.on("error", () => resolve(false));
			proc.on("close", (code) => resolve(code === 0));
		});
		if (ok) deleted.push(id);
		else failed.push(id);
	}
	return { deleted, failed };
}

/** Ids carrying a `free` label. The whole delegation story rests on these costing nothing. */
export function filterFreeModels(models: string[]): string[] {
	return models.filter((m) => /free/i.test(m));
}

export interface RunOptions {
	cli: string;
	agent: string;
	model: string;
	task: string;
	cwd: string;
	session?: string;
	continueLast?: boolean;
	files?: string[];
	title?: string;
	timeoutMs: number;
	signal?: AbortSignal;
	/** Called with the session id as soon as the stream reveals it, before the run ends. */
	onSession?: (sessionID: string) => void;
}

/** Run one headless OpenCode invocation and normalize its JSONL stream. */
export function runOpencode(opts: RunOptions): Promise<OpenCodeRunResult> {
	// `--standalone` is mandatory, not a preference.
	//
	// Without it `run` talks to the shared background service owned by the desktop
	// client, whose working directory is fixed to the user's home. On Windows the
	// CLI then ignores the spawned process's cwd entirely: every delegate landed in
	// C:\Users\lenovo, could not find the requested directory, and fell back to
	// scanning the whole drive. Measured: shared service -> 40s timeout, standalone
	// -> 10.8s and a correct answer. A private server also keeps delegate sessions
	// from piling into the desktop client's session list.
	const args = ["run", "--standalone", "--agent", opts.agent, "--auto", "--format", "json", "--model", opts.model];
	if (opts.continueLast) args.push("--continue");
	if (opts.session) args.push("--session", opts.session);
	if (opts.title) args.push("--title", opts.title);
	for (const file of opts.files ?? []) args.push("--file", file);
	args.push(opts.task);

	const result: OpenCodeRunResult = {
		agent: opts.agent,
		model: opts.model,
		task: opts.task,
		exitCode: 0,
		text: "",
		toolCalls: [],
		usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
		stderr: "",
	};

	return new Promise((resolve) => {
		let proc: ReturnType<typeof spawn>;
		try {
			proc = spawn(opts.cli, args, {
				cwd: opts.cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
		} catch (err) {
			result.exitCode = 1;
			result.errorMessage = err instanceof Error ? err.message : String(err);
			resolve(result);
			return;
		}

		let buffer = "";
		const texts: string[] = [];
		let killed = false;

		/**
		 * Kill the delegate and everything it spawned.
		 *
		 * `proc.kill()` only signals the direct child. Measured failure: a delegate told
		 * to run `Start-Sleep -Seconds 300` timed out, the CLI died, and the shell it had
		 * spawned kept running - an orphan that survives until reboot. On Windows the
		 * tree has to be killed explicitly with `taskkill /T`.
		 */
		const killTree = (signal: NodeJS.Signals) => {
			const pid = proc.pid;
			if (pid === undefined) return;
			if (process.platform === "win32") {
				try {
					spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
					return;
				} catch {
					/* fall through to a plain signal */
				}
			}
			try {
				// A negative pid signals the process group on POSIX.
				process.kill(-pid, signal);
			} catch {
				try {
					proc.kill(signal);
				} catch {
					/* already exited */
				}
			}
		};

		const kill = (why: "timeout" | "abort") => {
			if (killed) return;
			killed = true;
			if (why === "timeout") result.timedOut = true;
			else result.aborted = true;
			killTree("SIGTERM");
			setTimeout(() => {
				if (!proc.killed) killTree("SIGKILL");
			}, 3000);
		};

		const timer = setTimeout(() => kill("timeout"), opts.timeoutMs);
		if (opts.signal) {
			if (opts.signal.aborted) kill("abort");
			else opts.signal.addEventListener("abort", () => kill("abort"), { once: true });
		}

		const handleEvent = (event: any) => {
			const part = event?.part;
			switch (event?.type) {
				case "text": {
					if (typeof part?.text === "string" && part.text.length > 0) texts.push(part.text);
					break;
				}
				case "tool_use": {
					const state = part?.state;
					result.toolCalls.push({
						tool: String(part?.tool ?? part?.title ?? "tool"),
						title: part?.title,
						status: state?.status,
						input: state?.input,
						output: typeof state?.output === "string" ? state.output : undefined,
					});
					break;
				}
				case "step_finish": {
					if (part?.reason) result.stopReason = part.reason;
					if (typeof part?.cost === "number") result.usage.cost += part.cost;
					const tokens = part?.tokens;
					if (tokens) {
						result.usage.input += tokens.input ?? 0;
						result.usage.output += tokens.output ?? 0;
						result.usage.reasoning += tokens.reasoning ?? 0;
						result.usage.cacheRead += tokens.cache?.read ?? 0;
						result.usage.cacheWrite += tokens.cache?.write ?? 0;
					}
					break;
				}
				case "error": {
					// The payload nests the real message under `error`, e.g.
					// {"type":"error","error":{"type":"provider.quota","message":"...","status":402}}
					// Reading `part.message` here silently swallowed every reason (bad model,
					// missing credentials, quota) and reported only a generic string.
					const err = event?.error ?? {};
					const detail = err.message ?? event?.message ?? part?.message;
					const kind = err.type ?? part?.type;
					const status = typeof err.status === "number" ? ` (HTTP ${err.status})` : "";
					result.errorMessage = detail
						? `${kind ? `${kind}: ` : ""}${detail}${status}`
						: "opencode reported an error without a message";
					break;
				}
				default:
					break;
			}
			if (!result.sessionID && typeof event?.sessionID === "string") {
				result.sessionID = event.sessionID;
				try {
					opts.onSession?.(event.sessionID);
				} catch {
					/* a listener must not break the stream */
				}
			}
		};

		const processLine = (line: string) => {
			const trimmed = line.trim();
			if (!trimmed) return;
			try {
				handleEvent(JSON.parse(trimmed));
			} catch {
				/* non-JSON noise on stdout: ignore, stderr carries the real diagnostics */
			}
		};

		proc.stdout?.on("data", (data) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) processLine(line);
		});
		proc.stderr?.on("data", (data) => {
			result.stderr += data.toString();
		});

		proc.on("error", (err) => {
			clearTimeout(timer);
			result.exitCode = 1;
			result.errorMessage = result.errorMessage ?? err.message;
			resolve(result);
		});

		proc.on("close", (code) => {
			clearTimeout(timer);
			if (buffer.trim()) processLine(buffer);
			result.exitCode = code ?? 0;
			// The last text part is the final answer; earlier ones are narrating steps.
			result.text = texts.length > 0 ? texts[texts.length - 1] : "";
			resolve(result);
		});
	});
}
