/**
 * Tests for the grace-period mechanism (run-with-grace, adopt on timeout).
 *
 * The point of these is the boundary: a command that finishes just inside the grace
 * period must return its output synchronously, and one that finishes just outside must
 * become a background job that still delivers complete output. Both were verified by
 * hand before implementing; these lock the behaviour in.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { JobEngine } from "./engine.ts";
import { JobStore } from "./store.ts";
import { isProcessAlive } from "./process.ts";
import type { JobRecord } from "./types.ts";

const root = path.join(os.tmpdir(), `aj-grace-${Date.now()}`);
fs.mkdirSync(root, { recursive: true });

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

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Every message the engine tries to deliver, so duplicates are visible. */
const deliveries: string[] = [];

function makeEngine(tag: string) {
	const store = new JobStore(path.join(root, tag));
	const engine = new JobEngine({ store, target: { sendMessage: () => {}, hasUI: false, notify: () => {} } });
	engine.onFinished((record) => {
		void engine.deliver(record, (job) => `${job.id} ${job.state}`, true).then((sent) => {
			if (sent) deliveries.push(record.id);
		});
	});
	return { store, engine };
}

async function main() {
	console.log(`grace root: ${root}\n`);

	// ------------------------------------------------- G1 finishes inside the grace
	{
		console.log("G1: command finishing inside the grace period returns synchronously");
		const { engine } = makeEngine("g1");
		const t0 = Date.now();
		const { id, outcome } = await engine.runWithGrace({ command: "echo SYNC_IN_GRACE", timeoutSeconds: 60 }, 5000);
		const elapsed = Date.now() - t0;
		check("outcome is completed", outcome === "completed", outcome);
		check("did not wait the whole grace", elapsed < 4000, `${elapsed}ms`);
		const rec = engine.get(id);
		check("record is terminal", rec?.state === "done", String(rec?.state));
		check("output captured", (rec?.output ?? "").includes("SYNC_IN_GRACE"), JSON.stringify(rec?.output));
		// A result that returned inline must NOT also be announced as a message, or the
		// model sees it twice.
		check("no duplicate notification", deliveries.length === 0, `deliveries=${deliveries.length}`);
	}

	// -------------------------------------------------- G2 adopted after the grace
	{
		console.log("\nG2: command still running at the deadline is adopted, not killed");
		const { engine } = makeEngine("g2");
		const t0 = Date.now();
		const { id, outcome } = await engine.runWithGrace(
			{ command: "sleep 4; echo ADOPTED_OUTPUT", timeoutSeconds: 60 },
			1000,
		);
		const elapsed = Date.now() - t0;
		check("outcome is adopted", outcome === "adopted", outcome);
		check("returned at the deadline", elapsed < 2500, `${elapsed}ms`);
		const mid = engine.get(id);
		check("still running after adoption", mid?.state === "running", String(mid?.state));

		// It must keep running and finish on its own.
		const deadline = Date.now() + 20000;
		while (Date.now() < deadline && engine.get(id)?.state === "running") await wait(200);
		const rec = engine.get(id);
		check("finished on its own", rec?.state === "done", String(rec?.state));
		check("output complete after adoption", (rec?.output ?? "").includes("ADOPTED_OUTPUT"), JSON.stringify(rec?.output));
		check("exit code recorded", rec?.exitCode === 0, String(rec?.exitCode));
		check("adopted job notified exactly once", deliveries.filter((d) => d === id).length === 1, `count=${deliveries.filter((d) => d === id).length}`);
	}

	// ------------------------------------------------------- G3 the exact boundary
	{
		console.log("\nG3: commands straddling the deadline keep both output and exit code");
		const { engine } = makeEngine("g3");
		const results: Array<{ ok: boolean; mode: string; ms: number }> = [];
		for (const ms of [700, 900, 1100, 1300]) {
			const { id, outcome } = await engine.runWithGrace(
				{ command: `sleep ${ms / 1000}; echo BOUNDARY_${ms}`, timeoutSeconds: 60 },
				1000,
			);
			const deadline = Date.now() + 15000;
			while (Date.now() < deadline && engine.get(id)?.state === "running") await wait(150);
			const rec = engine.get(id);
			const ok = rec?.state === "done" && (rec?.output ?? "").includes(`BOUNDARY_${ms}`) && rec?.exitCode === 0;
			results.push({ ok: Boolean(ok), mode: outcome, ms });
		}
		for (const r of results) {
			check(`boundary ${r.ms}ms (${r.mode}) intact`, r.ok);
		}
	}

	// ------------------------------------------------------ G4 grace of zero = async
	{
		console.log("\nG4: a zero grace period behaves like immediate backgrounding");
		const { engine } = makeEngine("g4");
		const { id, outcome } = await engine.runWithGrace({ command: "sleep 3; echo ZERO_GRACE", timeoutSeconds: 60 }, 0);
		check("adopted immediately", outcome === "adopted", outcome);
		check("still running", engine.get(id)?.state === "running", String(engine.get(id)?.state));
		const deadline = Date.now() + 15000;
		while (Date.now() < deadline && engine.get(id)?.state === "running") await wait(200);
		check("eventually completes", engine.get(id)?.state === "done", String(engine.get(id)?.state));
	}

	// ------------------------------------------------ G5 failures are not adopted away
	{
		console.log("\nG5: a failing command inside the grace period reports failure");
		const { engine } = makeEngine("g5");
		const { id, outcome } = await engine.runWithGrace({ command: "echo boom; exit 3", timeoutSeconds: 60 }, 5000);
		check("completed", outcome === "completed", outcome);
		const rec = engine.get(id);
		check("state failed", rec?.state === "failed", String(rec?.state));
		check("exit code 3", rec?.exitCode === 3, String(rec?.exitCode));
	}

	// ------------------------------------------- G6 adopted jobs can still be killed
	{
		console.log("\nG6: an adopted job can be killed");
		const { engine } = makeEngine("g6");
		const marker = path.join(root, "g6.pid").replace(/\\/g, "/");
		const { id, outcome } = await engine.runWithGrace(
			{ command: `powershell -NoProfile -Command "Set-Content -Path '${marker}' -Value \\$PID; Start-Sleep -Seconds 200"`, timeoutSeconds: 600 },
			800,
		);
		check("adopted", outcome === "adopted", outcome);
		let ok = false;
		const dl = Date.now() + 10000;
		while (Date.now() < dl && !fs.existsSync(marker)) await wait(150);
		let pid = 0;
		try {
			pid = Number.parseInt(fs.readFileSync(marker, "utf8").trim(), 10);
		} catch {
			/* asserted below */
		}
		check("child started", Number.isSafeInteger(pid) && pid > 0, String(pid));
		if (pid > 0) check("child alive before kill", isProcessAlive(pid));
		const killed = await engine.kill(id, "g6");
		check("kill accepted", killed.ok, killed.message);
		await wait(2500);
		check("job is killed", engine.get(id)?.state === "killed", String(engine.get(id)?.state));
		if (pid > 0) check("child process gone", !isProcessAlive(pid), `pid ${pid}`);
	}

	// ---------------------------------------- G7 adoption does not lose early output
	{
		console.log("\nG7: output produced before adoption is preserved");
		const { engine } = makeEngine("g7");
		// Print something first, then sleep past the deadline.
		const { id, outcome } = await engine.runWithGrace(
			{ command: "echo EARLY_OUTPUT; sleep 3; echo LATE_OUTPUT", timeoutSeconds: 60 },
			1000,
		);
		check("adopted", outcome === "adopted", outcome);
		const dl = Date.now() + 15000;
		while (Date.now() < dl && engine.get(id)?.state === "running") await wait(200);
		const rec: JobRecord | null = engine.get(id);
		check("early output kept", (rec?.output ?? "").includes("EARLY_OUTPUT"), JSON.stringify(rec?.output));
		check("late output kept too", (rec?.output ?? "").includes("LATE_OUTPUT"), JSON.stringify(rec?.output));
	}

	// --------------------------- G8 both start paths announce (regression)
	//
	// The display depends on `onStarted`, and the two start paths each build their own
	// record. A notifier wired into only one of them produced a display that never
	// appeared for ordinary commands - because `mode: "auto"` goes through runWithGrace.
	// Measured exactly that: EVT_START fired zero times while the job ran normally.
	{
		console.log("\nG8: only real background jobs are announced as started");
		const { engine } = makeEngine("g8");
		const started: string[] = [];
		const terminal: string[] = [];
		engine.onStarted((record) => started.push(record.id));
		engine.onTerminal((record) => terminal.push(record.id));

		// A command that finishes inside the grace period is never a background job: it was
		// answered inline. Announcing it would flash a row for a few milliseconds, which is
		// what every ordinary command used to do.
		const quick = await engine.runWithGrace({ command: "echo QUICK", timeoutSeconds: 60 }, 5000);
		check("inline command is not announced as started", !started.includes(quick.id), JSON.stringify(started));
		check("inline command is still recorded as terminal", terminal.includes(quick.id), JSON.stringify(terminal));

		// A command that outlives the grace period IS adopted, and only then belongs on screen.
		const slow = await engine.runWithGrace({ command: "sleep 3; echo SLOW", timeoutSeconds: 60 }, 500);
		check("adopted", slow.outcome === "adopted", slow.outcome);
		check("adopted job announced its start", started.includes(slow.id), JSON.stringify(started));
		check("adopted job is marked a background job", engine.get(slow.id)?.isBackgroundJob === true,
			String(engine.get(slow.id)?.isBackgroundJob));
		check("inline command is NOT marked a background job", engine.get(quick.id)?.isBackgroundJob === false,
			String(engine.get(quick.id)?.isBackgroundJob));

		// The explicit-background path is a background job from birth.
		const bg = engine.startProcess({ command: "echo B", timeoutSeconds: 60 });
		check("background path announced its start", started.includes(bg.id), JSON.stringify(started));
		check("mode:background is marked a background job", engine.get(bg.id)?.isBackgroundJob === true,
			String(engine.get(bg.id)?.isBackgroundJob));

		const dl = Date.now() + 20000;
		while (Date.now() < dl && terminal.length < 3) await wait(150);
		check("every job reported its end",
			[quick.id, slow.id, bg.id].every((id) => terminal.includes(id)), JSON.stringify(terminal));
	}

	// ------------------------------- G9 terminal fires even when delivery is suppressed
	//
	// A command finishing inside the grace period has its result handed back inline, so
	// `onFinished` (the delivery channel) is skipped. The display must still be told, or
	// that job's row would stay on screen forever.
	{
		console.log("\nG9: a job that delivers inline still reports terminal");
		const { engine } = makeEngine("g9");
		const terminal: string[] = [];
		const delivered: string[] = [];
		engine.onTerminal((record) => terminal.push(record.id));
		engine.onFinished((record) => delivered.push(record.id));

		// Finishes well inside the grace period: result returned synchronously.
		const { id, outcome } = await engine.runWithGrace({ command: "echo FAST", timeoutSeconds: 60 }, 8000);
		check("completed inline", outcome === "completed", outcome);
		check("terminal observer still told", terminal.includes(id), JSON.stringify(terminal));
		check("delivery correctly skipped", !delivered.includes(id), JSON.stringify(delivered));
	}

	//
	// A command that finished inside the grace period was never a background job: the caller
	// already holds its result and will never look it up by id. Leaving a record and an
	// output file behind would mean one pair per ordinary short command - hundreds per
	// session, all unfindable from the UI and indistinguishable from real jobs in a listing.
	// The journal has always filtered these (journal.ts); the working-state store now agrees.
	{
		console.log("\nG10: an inline command leaves no files behind");
		const { engine, store } = makeEngine("g10");
		const { id, outcome } = await engine.runWithGrace({ command: "echo INLINE_ONLY", timeoutSeconds: 60 }, 8000);
		check("completed inline", outcome === "completed", outcome);
		// The record is still readable in memory - that is what the caller formats its result from.
		check("record still readable in memory", (engine.get(id)?.output ?? "").includes("INLINE_ONLY"));
		// But it must not have survived on disk.
		check("no job record file", !fs.existsSync(path.join(store.dir(), `${id}.json`)), id);
		check("no output file", !fs.existsSync(store.outputPathFor(id)), id);
	}

	// A real background job must still be on disk: the whole point of the store is that
	// `/jobs` and `job_logs` can find it after the fact.
	{
		console.log("\nG11: an adopted job still persists");
		const { engine, store } = makeEngine("g11");
		const { id, outcome } = await engine.runWithGrace({ command: "sleep 3; echo ADOPTED", timeoutSeconds: 60 }, 300);
		check("adopted", outcome === "adopted", outcome);
		const deadline = Date.now() + 15000;
		while (Date.now() < deadline && engine.get(id)?.state === "running") await wait(200);
		check("finished", engine.get(id)?.state === "done", String(engine.get(id)?.state));
		check("record file kept", fs.existsSync(path.join(store.dir(), `${id}.json`)), id);
		check("output file kept", fs.existsSync(store.outputPathFor(id)), id);
	}

	console.log(`PASS ${pass}   FAIL ${fail}`);
	// A failing suite must fail the process, or a CI gate reads a red run as green.
	// Measured before this existed: `PASS 1 FAIL 2` still exited 0.
	process.exitCode = fail > 0 ? 1 : 0;
	// Keep the directory only on failure - that is when the files are still worth
	// inspecting. On success it is pure litter: each run invented a new timestamped
	// directory and nothing ever removed it, so %TEMP% accumulated dozens of them.
	if (fail === 0) {
		try {
			fs.rmSync(root, { recursive: true, force: true });
		} catch {
			console.log(`root: ${root} (could not be removed)`);
		}
	} else {
		console.log(`root kept for inspection: ${root}`);
	}
}

await main();
