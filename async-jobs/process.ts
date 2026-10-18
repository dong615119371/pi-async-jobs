/**
 * Process execution and whole-tree termination.
 *
 * Design notes, learned the hard way and from reading how a similar project
 * (ismailsaleekh/pi-background-tasks) solves the same problems. The code here is
 * ours; only the failure modes were borrowed.
 *
 * 1. `child.kill()` signals the direct child only. A job that spawns a shell
 *    which spawns a sleeper leaves that sleeper running forever - measured: a
 *    killing one process left a `Start-Sleep -Seconds 300` alive until reboot.
 *    The tree has to be killed explicitly.
 *
 * 2. On Windows that means `taskkill /PID <pid> /T`, and its path must be resolved
 *    absolutely. Relying on PATH means a stripped environment silently kills
 *    nothing; a missing `SystemRoot` must fail loudly rather than degrade.
 *
 * 3. Terminate first, force second. A graceful `/T` gives a well-behaved process a
 *    chance to flush; `/T /F` is the fallback. Measured: Windows needs both.
 *
 * 4. The helper invocation must be bounded. `taskkill` can hang, and a promise
 *    with no deadline hangs the caller forever.
 */

import { spawn } from "node:child_process";
import * as path from "node:path";

export type KillSignal = "terminate" | "force";

export interface TaskkillResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	/** True when the helper could not be launched at all (e.g. taskkill missing). */
	unavailable: boolean;
}

const TASKKILL_TIMEOUT_MS = 5000;
const MAX_CAPTURE = 8 * 1024;

/**
 * Absolute path to `taskkill.exe`, derived from the environment rather than PATH.
 *
 * Returns null when neither `SystemRoot` nor `WINDIR` is usable, so the caller can
 * surface the failure instead of pretending the kill succeeded.
 */
export function resolveTaskkillPath(env: NodeJS.ProcessEnv = process.env): string | null {
	const lookup = (name: string): string | undefined => {
		const direct = env[name];
		if (direct !== undefined) return direct;
		const lower = name.toLowerCase();
		for (const key of Object.keys(env)) {
			if (key.toLowerCase() === lower) return env[key];
		}
		return undefined;
	};
	const root = lookup("SystemRoot") ?? lookup("WINDIR");
	if (!root) return null;
	const trimmed = root.trim();
	if (trimmed.length === 0 || trimmed.includes("\0")) return null;
	if (!path.win32.isAbsolute(trimmed)) return null;
	return path.win32.join(trimmed, "System32", "taskkill.exe");
}

/**
 * Run one `taskkill` phase against a pid and its descendants.
 *
 * Never rejects: a kill helper that cannot run must not take down the caller. The
 * outcome says what happened, including `unavailable` when the executable is
 * missing, so the caller can report a real failure instead of a false success.
 */
export function runTaskkill(pid: number, phase: KillSignal, timeoutMs = TASKKILL_TIMEOUT_MS): Promise<TaskkillResult> {
	return new Promise((resolve) => {
		const executable = resolveTaskkillPath();
		if (!executable) {
			resolve({
				exitCode: null,
				stdout: "",
				stderr: "taskkill unavailable: neither SystemRoot nor WINDIR resolved to an absolute path",
				timedOut: false,
				unavailable: true,
			});
			return;
		}

		// `/T` includes the whole descendant tree; `/F` upgrades to forced.
		const args = ["/PID", String(pid), "/T"];
		if (phase === "force") args.push("/F");

		let stdout = "";
		let stderr = "";
		let settled = false;
		let child: ReturnType<typeof spawn> | undefined;

		const finish = (result: TaskkillResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};

		const timer = setTimeout(() => {
			stderr += `\ntaskkill ${phase} timed out after ${timeoutMs}ms`;
			try {
				child?.kill("SIGKILL");
			} catch {
				/* helper already gone */
			}
			finish({ exitCode: null, stdout, stderr, timedOut: true, unavailable: false });
		}, timeoutMs);

		try {
			child = spawn(executable, args, {
				shell: false,
				windowsHide: true,
				windowsVerbatimArguments: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (error) {
			finish({
				exitCode: null,
				stdout,
				stderr: `taskkill spawn failed: ${error instanceof Error ? error.message : String(error)}`,
				timedOut: false,
				unavailable: true,
			});
			return;
		}

		const capture = (chunk: Buffer | string, into: "stdout" | "stderr") => {
			const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
			if (into === "stdout") {
				if (stdout.length < MAX_CAPTURE) stdout += text;
			} else if (stderr.length < MAX_CAPTURE) {
				stderr += text;
			}
		};

		child.stdout?.on("data", (d) => capture(d, "stdout"));
		child.stderr?.on("data", (d) => capture(d, "stderr"));
		child.on("error", (error) => {
			finish({
				exitCode: null,
				stdout,
				stderr: stderr + `\ntaskkill error: ${error.message}`,
				timedOut: false,
				unavailable: true,
			});
		});
		child.on("close", (code) => {
			finish({ exitCode: code, stdout, stderr, timedOut: false, unavailable: false });
		});
	});
}

export interface KillTreeResult {
	/** True when the target is believed to be gone. */
	terminated: boolean;
	/** True when the forced phase could not run, so descendants may have leaked. */
	leaked: boolean;
	notes: string[];
}

/**
 * Kill a process and its descendants, gracefully then forcefully.
 *
 * `isAlive` lets the caller confirm the process actually exited; checking it is what
 * separates "we sent a signal" from "it is gone". Without that check a successful
 * helper invocation can still mask a surviving tree.
 */
export async function killProcessTree(pid: number, isAlive?: () => boolean): Promise<KillTreeResult> {
	const notes: string[] = [];

	if (process.platform === "win32") {
		const graceful = await runTaskkill(pid, "terminate");
		if (graceful.unavailable) {
			notes.push(graceful.stderr.trim());
			// Fall back to signalling the direct child, which at least covers the
			// common case where the job spawned nothing of its own.
			try {
				process.kill(pid, "SIGTERM");
			} catch {
				/* already gone */
			}
			return { terminated: isAlive ? !isAlive() : true, leaked: true, notes };
		}

		const graceDelay = 1200;
		await new Promise((resolve) => setTimeout(resolve, graceDelay));
		if (isAlive && !isAlive()) return { terminated: true, leaked: false, notes };

		const forced = await runTaskkill(pid, "force");
		if (forced.timedOut) notes.push(`forced taskkill timed out: ${forced.stderr.trim()}`);
		await new Promise((resolve) => setTimeout(resolve, 400));

		const gone = isAlive ? !isAlive() : true;
		if (!gone) notes.push(`process ${pid} still alive after tree kill; descendants may have leaked`);
		return { terminated: gone, leaked: !gone, notes };
	}

	// POSIX: a negative pid addresses the whole process group.
	const signalGroup = (signal: NodeJS.Signals) => {
		try {
			process.kill(-pid, signal);
			return true;
		} catch {
			try {
				process.kill(pid, signal);
				return true;
			} catch {
				return false;
			}
		}
	};

	signalGroup("SIGTERM");
	await new Promise((resolve) => setTimeout(resolve, 1200));
	if (isAlive && !isAlive()) return { terminated: true, leaked: false, notes };

	signalGroup("SIGKILL");
	await new Promise((resolve) => setTimeout(resolve, 400));
	const gone = isAlive ? !isAlive() : true;
	if (!gone) notes.push(`process ${pid} still alive after SIGKILL; descendants may have leaked`);
	return { terminated: gone, leaked: !gone, notes };
}

/** Cheap liveness probe. `signal 0` performs the permission check without delivering. */
export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means it exists but belongs to someone else.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}
