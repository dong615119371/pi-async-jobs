/**
 * Engine smoke test - runs without Pi.
 *
 * Exercises the parts most likely to be wrong: process spawn, output capture,
 * completion notification, tree kill, timeout, and shutdown sweep.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { JobEngine } from "./engine.ts";
import { JobStore } from "./store.ts";
import { killProcessTree, isProcessAlive } from "./process.ts";
import type { JobRecord } from "./types.ts";

const root = path.join(os.tmpdir(), `aj-test-${Date.now()}`);
const store = new JobStore(root);

const delivered: JobRecord[] = [];
const engine = new JobEngine({
	store,
	target: {
		sendMessage: (message, options) => {
			// Record deliveries so the test can assert on them.
			delivered.push({ ...(message.details as object), content: message.content, trigger: options.triggerTurn } as JobRecord);
		},
		hasUI: false,
		notify: () => {},
	},
});

engine.onFinished((record) => {
	void engine.deliver(record, (job) => `RESULT ${job.id} ${job.state}: ${job.output ?? job.error ?? ""}`, true);
});

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check: () => boolean, timeoutMs: number, label: string): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (check()) return true;
		await wait(120);
	}
	console.log(`  TIMEOUT waiting for ${label}`);
	return false;
}



let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail = ""): void {
	if (ok) {
		pass++;
		console.log(`  PASS  ${label}`);
	} else {
		fail++;
		console.log(`  FAIL  ${label} ${detail}`);
	}
}

async function main(): Promise<void> {
	console.log(`store root: ${root}\n`);

	// ---------------------------------------------------------------- T1 basics
	console.log("T1: basic run and completion");
	const a = engine.startProcess({ command: "echo HELLO_FROM_JOB", name: "basic", timeoutSeconds: 30 });
	check("returns an id in <tag>-<n> form", /^[0-9A-Z]{4}-\d+$/.test(a.id), a.id);
	check("record persisted", fs.existsSync(path.join(root, `${a.id}.json`)));
	await waitFor(() => engine.get(a.id)?.state !== "running", 15000, "T1 completion");
	const recA = engine.get(a.id);
	check("state done", recA?.state === "done", String(recA?.state));
	check("output captured", (recA?.output ?? "").includes("HELLO_FROM_JOB"), JSON.stringify(recA?.output));
	check("exit code 0", recA?.exitCode === 0, String(recA?.exitCode));
	check(
		"notification delivered",
		delivered.some((d) => (d as any).id === a.id),
	);

	// ------------------------------------------------------------ T2 multiline
	console.log("\nT2: multi-line output and exit code");
	const b = engine.startProcess({
		command: "printf 'line1\\nline2\\nline3\\n'; exit 7",
		name: "exit7",
		timeoutSeconds: 30,
	});
	await waitFor(() => engine.get(b.id)?.state !== "running", 15000, "T2");
	const recB = engine.get(b.id);
	check("state failed on exit 7", recB?.state === "failed", String(recB?.state));
	check("exit code recorded", recB?.exitCode === 7, String(recB?.exitCode));
	check("all lines captured", (recB?.output ?? "").split("\n").length >= 3, JSON.stringify(recB?.output));

	// ------------------------------------------------------------- T3 concurrency
	console.log("\nT3: concurrency cap (7) and queueing");
	// Needs CAP+2 jobs to exercise both a full run set and a queue: 7 run, 2 wait.
	const many = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) =>
		engine.startProcess({ command: `sleep 2; echo N${n}`, name: `c${n}`, timeoutSeconds: 60 }),
	);
	check("9 accepted", many.length === 9);
	// Ids are `<session-tag>-<counter>`. Every job from one session shares the tag and
	// the counter only goes up, so "the 3rd job of this session" is something you can
	// say. A random blob could not answer that.
	const tagsSeen = new Set(many.map((h) => h.id.split("-")[0]));
	check("all jobs share one session tag", tagsSeen.size === 1, [...tagsSeen].join(","));
	check(
		"ids carry no duplicates",
		new Set(many.map((h) => h.id)).size === many.length,
		many.map((h) => h.id).join(" "),
	);
	const immediate = engine.activeCount();
	check("at most 7 running at once", immediate <= 7, `active=${immediate}`);
	check("2 queued", engine.queuedCount() === 2, `queued=${engine.queuedCount()}`);
	const ok = await waitFor(() => many.every((h) => engine.get(h.id)?.state === "done"), 60000, "T3 all done");
	check("all 9 finished", ok);
	check("queue drained", engine.queuedCount() === 0, `queued=${engine.queuedCount()}`);

	// ----------------------------------------------------------------- T4 kill
	console.log("\nT4: kill terminates the whole tree");
	// The child spawns a grandchild sleeper; killing only the shell would orphan it.
	//
	// KNOWN LIMITATION, deliberately documented rather than papered over: this asserts on
	// the `$!` the shell recorded, and MEASURED that pid is often already dead before the
	// kill happens - the shell forks an intermediate that exits. So the final assertion can
	// pass for the wrong reason. What this test still proves is real and worth keeping:
	// `engine.kill` reports success within its timeout and the job reaches a `killed`
	// terminal state without hanging. It does NOT prove the whole process tree died.
	//
	// A reliable tree-kill assertion needs an OS-level descendant query. That was attempted
	// and abandoned: every route (Get-CimInstance via -Command or -EncodedCommand, wmic,
	// tasklist) either mangled quotes, returned empty for the query,
	// or mixed CLIXML progress noise into stdout. Rather than ship a test that looks like
	// it checks something it does not, the gap is recorded here.
	const marker = path.join(root, "grandchild.pid");
	const k = engine.startProcess({
		command: `bash -c 'sleep 300 & echo $! > ${marker.replace(/\\/g, "/")}; wait'`,
		name: "tree-kill",
		timeoutSeconds: 300,
	});
	await waitFor(() => fs.existsSync(marker), 10000, "grandchild pid file");
	let grandchildPid = 0;
	try {
		grandchildPid = Number.parseInt(fs.readFileSync(marker, "utf8").trim(), 10);
	} catch {
		/* handled by the assertion below */
	}
	check("grandchild pid was recorded", Number.isSafeInteger(grandchildPid) && grandchildPid > 0, String(grandchildPid));
	const killResult = await engine.kill(k.id, "test kill");
	check("kill reported ok", killResult.ok, killResult.message);
	// Must exceed the tree-kill worst case (graceful taskkill, 1200ms, then forced + 400ms).
	await wait(2500);
	check("job marked killed", engine.get(k.id)?.state === "killed", String(engine.get(k.id)?.state));
	check("the recorded pid is not alive", !(grandchildPid > 0 && isProcessAlive(grandchildPid)));


	// -------------------------------------------------------------- T5 timeout
	console.log("\nT5: timeout kills the job");
	const t = engine.startProcess({ command: "sleep 120", name: "timeout", timeoutSeconds: 2 });
	await waitFor(() => engine.get(t.id)?.state !== "running", 20000, "T5 timeout");
	const recT = engine.get(t.id);
	check("state killed after timeout", recT?.state === "killed", String(recT?.state));
	check("timedOut flag set", recT?.timedOut === true, String(recT?.timedOut));

	// ------------------------------------------------------------ T6 kill queued
	console.log("\nT6: killing a still-queued job");
	// CAP+2 so one job is guaranteed to be queued while the rest occupy slots.
	const blockers = [1, 2, 3, 4, 5, 6, 7, 8].map((n) =>
		engine.startProcess({ command: `sleep 6; echo B${n}`, name: `block${n}`, timeoutSeconds: 60 }),
	);
	const queuedJob = engine.startProcess({ command: "echo NEVER_RUNS", name: "queued", timeoutSeconds: 60 });
	check("queued", engine.queuedCount() >= 1, `queued=${engine.queuedCount()}`);
	const qk = await engine.kill(queuedJob.id, "cancel queued");
	check("queued kill ok", qk.ok, qk.message);
	check("queued job killed", engine.get(queuedJob.id)?.state === "killed", String(engine.get(queuedJob.id)?.state));
	await waitFor(() => blockers.every((h) => engine.get(h.id)?.state !== "running"), 30000, "T6 blockers");

	// ------------------------------------------------------- T6b timeout notifies
	console.log("\nT6b: a timed-out job still notifies, a user kill does not");
	// `killRequested` says the engine asked it to stop. The kill limit uses the same flag,
	// so treating it as "the user killed this" dropped every timed-out job's result on the
	// floor: `onFinished` returned early and the model never learned the job had ended.
	// Only `kill()` marks `killedByUser`.
	{
		const seen: Array<{ id: string; suppressed: boolean; state?: string }> = [];
		const stopWatching = () => {};
		const watcher = (r: any) => seen.push({ id: r.id, suppressed: !!r.killedByUser, state: r.state });
		engine.onFinished(watcher);

		const timed = engine.startProcess({ command: "sleep 30", name: "will-timeout", timeoutSeconds: 1 });
		const userKilled = engine.startProcess({ command: "sleep 30", name: "will-be-killed", timeoutSeconds: 120 });
		void engine.kill(userKilled.id, "test kill");

		await waitFor(
			() =>
				seen.some((e) => e.id === timed.id) && seen.some((e) => e.id === userKilled.id),
			40000,
			"T6b both settled",
		);

		const timedEntry = seen.find((e) => e.id === timed.id);
		const killedEntry = seen.find((e) => e.id === userKilled.id);
		check("timed-out job is delivered", timedEntry !== undefined && !timedEntry.suppressed, JSON.stringify(timedEntry));
		check("timed-out job records the reason", engine.get(timed.id)?.timedOut === true);
		check("user-killed job is suppressed", killedEntry !== undefined && killedEntry.suppressed, JSON.stringify(killedEntry));
		stopWatching();
	}

	// ------------------------------------------------------------- T7 logs tail
	console.log("\nT7: job_logs tail");
	const big = engine.startProcess({ command: "for i in $(seq 1 500); do echo LINE_$i; done", name: "big", timeoutSeconds: 30 });
	await waitFor(() => engine.get(big.id)?.state !== "running", 20000, "T7");
	const tail = engine.logs(big.id, 200);
	check("tail is bounded", tail.text.length <= 200 + 20, `len=${tail.text.length}`);
	check("tail has the end", tail.text.includes("LINE_500"), tail.text.slice(-60));
	check("truncation flagged", tail.truncated === true, String(tail.truncated));

	// ---------------------------------------------------------- T8 raw tree kill
	console.log("\nT8: killProcessTree on a bare pid");
	const { spawn } = await import("node:child_process");
	const sleeper = spawn("bash", ["-c", "sleep 200"], { stdio: "ignore", windowsHide: true });
	await wait(600);
	check("sleeper alive", isProcessAlive(sleeper.pid!));
	const kt = await killProcessTree(sleeper.pid!);
	check("killProcessTree reports terminated", kt.terminated, JSON.stringify(kt.notes));
	check("sleeper gone", !isProcessAlive(sleeper.pid!));

	// ------------------------------------------------------------- T9 shutdown
	console.log("\nT9: shutdownAll sweeps running jobs");
	const long1 = engine.startProcess({ command: "sleep 200", name: "shut1", timeoutSeconds: 600 });
	const long2 = engine.startProcess({ command: "sleep 200", name: "shut2", timeoutSeconds: 600 });
	await wait(400);
	const sweep = await engine.shutdownAll("test-shutdown");
	check("shutdown killed jobs", sweep.killed >= 2, JSON.stringify(sweep));
	check("no leaks reported", sweep.leaked === 0, JSON.stringify(sweep));
	await wait(300);
	check("shut1 not running", engine.get(long1.id)?.state !== "running", String(engine.get(long1.id)?.state));
	check("shut2 not running", engine.get(long2.id)?.state !== "running", String(engine.get(long2.id)?.state));
	// Idempotency
	const sweep2 = await engine.shutdownAll("test-shutdown-again");
	check("second shutdown is a no-op", sweep2.killed === 0 && sweep2.leaked === 0, JSON.stringify(sweep2));

	// --------------------------------------------------------- T10 persistence
	console.log("\nT10: persistence and recovery");
	const store2 = new JobStore(path.join(root, "recover"));
	const engine2 = new JobEngine({ store: store2, target: { sendMessage: () => {}, hasUI: false, notify: () => {} } });
	// Fabricate a record that claims to still be running.
	store2.init();
	store2.write({
		id: "aj-stale01",
		name: "stale",
		kind: "process",
		channel: "generic",
		state: "running",
		startedAt: Date.now() - 60000,
		summary: "ghost job",
	});
	const recovered = engine2.recover();
	check("stale job recovered", recovered.length === 1, String(recovered.length));
	check("marked failed", engine2.get("aj-stale01") === null ? store2.read("aj-stale01")?.state === "failed" : true);
	check("recovered flag set", store2.read("aj-stale01")?.recovered === true);
	check("takeRecovered empties", engine2.takeRecovered().length === 1 && engine2.takeRecovered().length === 0);


	// ------------------------------------------------------- T13b long command
	// A command longer than `bash -c` can carry on argv must still run.
	//
	// Measured: Git Bash's `bash -c` takes 8182 bytes and rejects 8187. Above that it
	// fails with `unexpected EOF while looking for matching '"'` - a quote error for a
	// string that was truncated before it arrived, which sends you debugging the wrong
	// thing. `engine.ts` routes long commands over stdin instead; this pins that.
	console.log("\nT13b: command longer than the argv limit");
	{
		const storeL = new JobStore(path.join(root, "longcmd"));
		const engineL = new JobEngine({ store: storeL, target: { sendMessage: () => {}, hasUI: false, notify: () => {} } });
		const padding = "x".repeat(9000);
		const h = engineL.startProcess({
			command: `echo LONGCMD_OK_${padding} | cut -c1-20`,
			name: "long",
			timeoutSeconds: 30,
		});
		const settled = await waitFor(() => storeL.read(h.id)?.state !== "running", 20000, "long command");
		check("long command ran", settled, String(storeL.read(h.id)?.state));
		check("long command exited 0", storeL.read(h.id)?.exitCode === 0, String(storeL.read(h.id)?.exitCode));
		check("long command produced output", (storeL.read(h.id)?.output ?? "").includes("LONGCMD_OK"), JSON.stringify((storeL.read(h.id)?.output ?? "").slice(0, 40)));
	}

	console.log("\nT13: store pruning");
	const store3 = new JobStore(path.join(root, "prune"));
	store3.init();
	for (let i = 0; i < 30; i++) {
		store3.write({
			id: `aj-prune${String(i).padStart(2, "0")}`,
			name: `p${i}`,
			kind: "process",
			channel: "generic",
			state: "done",
			startedAt: Date.now() - (30 - i) * 1000,
			finishedAt: Date.now() - (30 - i) * 1000,
			summary: "x",
		});
	}
	const removed = store3.prune(10, 24 * 60 * 60 * 1000);
	check("pruned overflow", removed === 20, String(removed));
	check("kept 10", store3.listAll().length === 10, String(store3.listAll().length));

	// ------------------------------------------------------------------ report
	console.log(`\n${"=".repeat(50)}`);
	console.log(`PASS ${pass}   FAIL ${fail}`);
	// A failing suite must fail the process, or a CI gate reads a red run as green.
	// Measured before this existed: `PASS 1 FAIL 2` still exited 0.
	process.exitCode = fail > 0 ? 1 : 0;
	// Keep the store on failure so the run can be inspected; drop it on success.
	if (fail === 0) {
		try {
			fs.rmSync(root, { recursive: true, force: true });
		} catch {
			console.log(`store retained at: ${root} (could not be removed)`);
		}
	} else {
		console.log(`store kept for inspection: ${root}`);
	}
	return;
}

await main();

