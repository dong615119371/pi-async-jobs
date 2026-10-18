/**
 * Stress and limit tests.
 *
 * Corrections over the first version, which produced three false results:
 *  - leak detection matched the probe's own command line (fixed: jobs record their
 *    exact Windows PID and the probe only checks those PIDs);
 *  - the output-volume assertion checked the notification preview, which is capped
 *    by design (fixed: the job's log FILE is what must hold everything);
 *  - phases shared one engine, so a later phase ran after shutdown and threw
 *    (fixed: each independent phase gets its own engine).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { JobEngine } from "./engine.ts";
import { JobStore } from "./store.ts";
import { isProcessAlive } from "./process.ts";

const root = path.join(os.tmpdir(), `aj-stress2-${Date.now()}`);
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

async function waitFor(fn: () => boolean, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (fn()) return true;
		await wait(120);
	}
	return false;
}

function makeEngine(tag: string) {
	const store = new JobStore(path.join(root, tag));
	const engine = new JobEngine({ store, target: { sendMessage: () => {}, hasUI: false, notify: () => {} } });
	engine.onFinished((record) => {
		void engine.deliver(record, (job) => `${job.id} ${job.state}`, true);
	});
	return { store, engine };
}

/** A job containing a real Windows process that records its own Windows PID. */
function trackedBody(dir: string, tag: string, sleepSeconds: number) {
	const pidFile = path.join(dir, `${tag}.winpid`).replace(/\\/g, "/");
	const command = `powershell -NoProfile -Command "Set-Content -Path '${pidFile}' -Value \\$PID; Start-Sleep -Seconds ${sleepSeconds}"`;
	return { command, pidFile };
}

function readPid(file: string): number {
	try {
		return Number.parseInt(fs.readFileSync(file, "utf8").trim(), 10);
	} catch {
		return 0;
	}
}


async function main() {
	console.log(`stress root: ${root}\n`);

	// ------------------------------------------------------------- P1 load
	{
		console.log("P1: 30 jobs at once - slot accounting under load");
		const { store, engine } = makeEngine("p1");
		const burst = Array.from({ length: 30 }, (_, i) =>
			engine.startProcess({ command: `echo JOB_${i}`, name: `b${i}`, timeoutSeconds: 60 }),
		);
		check("all 30 accepted", burst.length === 30);
		check("never more than 7 slots in use", engine.activeCount() <= 7, `active=${engine.activeCount()}`);
		const allTerminal = await waitFor(() => burst.every((h) => store.read(h.id)?.state !== "running"), 120000);
		check("all 30 terminal", allTerminal);
		check("slots all released", engine.activeCount() === 0, `active=${engine.activeCount()}`);
		check("queue drained", engine.queuedCount() === 0, `queued=${engine.queuedCount()}`);
	}

	// -------------------------------------------------------- P2 output volume
	{
		console.log("\nP2: 1MB+ of output - the log FILE must hold all of it");
		const { store, engine } = makeEngine("p2");
		const job = engine.startProcess({
			command: "for i in $(seq 1 15000); do echo 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'; done",
			name: "big",
			timeoutSeconds: 120,
		});
		const done = await waitFor(() => store.read(job.id)?.state !== "running", 120000);
		check("job finished", done);
		const fileBytes = fs.statSync(store.outputPathFor(job.id)).size;
		check("log file holds the full output (>500KB)", fileBytes > 500_000, `bytes=${fileBytes}`);
		const rec = store.read(job.id);
		check(
			"notification preview is capped (by design)",
			Buffer.byteLength(rec?.output ?? "", "utf8") <= 64 * 1024,
			`bytes=${Buffer.byteLength(rec?.output ?? "", "utf8")}`,
		);
		const tail = engine.logs(job.id, 2000);
		check("logs returns a bounded tail", tail.text.length <= 2100, `len=${tail.text.length}`);
		check("tail contains the last line", tail.text.includes("XXXXX"), "");
		check("logs reads from the file", tail.totalBytes === fileBytes, `${tail.totalBytes} vs ${fileBytes}`);
	}

	// ---------------------------------------------------- P3 real kill leak check
	{
		console.log("\nP3: killing a job also kills its children (real Windows PIDs)");
		const { engine } = makeEngine("p3");
		const dir = path.join(root, "p3");
		const jobs: Array<{ h: ReturnType<typeof engine.startProcess>; pidFile: string }> = [];
		for (let i = 0; i < 4; i++) {
			const { command, pidFile } = trackedBody(dir, `k${i}`, 240);
			jobs.push({ h: engine.startProcess({ command, name: `k${i}`, timeoutSeconds: 600 }), pidFile });
		}
		await waitFor(() => jobs.every((j) => fs.existsSync(j.pidFile)), 20000);
		await wait(1500);
		const pids = jobs.map((j) => readPid(j.pidFile)).filter((p) => p > 0);
		const aliveBefore = pids.filter(isProcessAlive).length;
		check("all 4 children alive before kill", aliveBefore === 4, `alive=${aliveBefore}`);

		await Promise.all(jobs.map((j) => engine.kill(j.h.id, "p3")));
		await wait(3000);
		const aliveAfter = pids.filter(isProcessAlive);
		check("no survivors after engine.kill", aliveAfter.length === 0, aliveAfter.join(","));
	}

	// --------------------------------------------------------- P4 shutdown path
	{
		console.log("\nP4: shutdownAll kills everything, and is idempotent");
		const { engine } = makeEngine("p4");
		const dir = path.join(root, "p4");
		const jobs = Array.from({ length: 4 }, (_, i) => {
			const { command, pidFile } = trackedBody(dir, `s${i}`, 240);
			return { h: engine.startProcess({ command, name: `s${i}`, timeoutSeconds: 600 }), pidFile };
		});
		await waitFor(() => jobs.every((j) => fs.existsSync(j.pidFile)), 20000);
		await wait(1500);
		const pids = jobs.map((j) => readPid(j.pidFile)).filter((p) => p > 0);

		const sweep = await engine.shutdownAll("p4-test");
		await wait(3000);
		const aliveAfter = pids.filter(isProcessAlive);
		check("shutdown reports kills", sweep.killed === 4, JSON.stringify(sweep));
		check("shutdown reports no leaks", sweep.leaked === 0, JSON.stringify(sweep));
		check("no survivors after shutdown", aliveAfter.length === 0, aliveAfter.join(","));

		const again = await engine.shutdownAll("p4-again");
		check("second shutdown is a no-op", again.killed === 0 && again.leaked === 0, JSON.stringify(again));

		let refused = false;
		try {
			engine.startProcess({ command: "echo nope" });
		} catch {
			refused = true;
		}
		check("work refused after shutdown", refused);

		let emptyRejected = false;
		try {
			const { engine: fresh } = makeEngine("p4b");
			fresh.startProcess({ command: "   " });
		} catch {
			emptyRejected = true;
		}
		check("empty command rejected", emptyRejected);
	}

	// ------------------------------------------------------------- P5 kill storm
	{
		console.log("\nP5: 12 concurrent kills, some of them still queued");
		const { store, engine } = makeEngine("p5");
		const all = Array.from({ length: 12 }, (_, i) =>
			engine.startProcess({ command: "sleep 300", name: `st${i}`, timeoutSeconds: 900 }),
		);
		check("7 running (the cap)", engine.activeCount() === 7, `active=${engine.activeCount()}`);
		check("5 queued", engine.queuedCount() === 5, `queued=${engine.queuedCount()}`);
		await wait(800);
		const results = await Promise.all(all.map((h) => engine.kill(h.id, "storm")));
		check("every kill succeeded", results.every((r) => r.ok), JSON.stringify(results.filter((r) => !r.ok)));
		await wait(2500);
		const states = all.map((h) => store.read(h.id)?.state);
		check("all 12 are killed", states.every((s) => s === "killed"), states.join(","));
		check("engine is idle", engine.activeCount() === 0 && engine.queuedCount() === 0, `${engine.activeCount()}/${engine.queuedCount()}`);
	}

	// -------------------------------------------------------------- P6 recovery
	{
		console.log("\nP6: records left running by a dead session are recovered");
		const { store, engine } = makeEngine("p6");
		for (let i = 0; i < 3; i++) {
			store.write({
				id: `aj-dead${i}`,
				name: `dead${i}`,
				kind: "process",
				channel: "generic",
				state: "running",
				startedAt: Date.now() - 5000,
				summary: "ghost",
			});
		}
		const recovered = engine.recover();
		check("all recovered", recovered.length === 3, String(recovered.length));
		check("marked failed", recovered.every((r) => r.state === "failed"));
		check("explained", recovered.every((r) => (r.error ?? "").includes("interrupted")));
		check("store reflects recovery", store.read("aj-dead0")?.state === "failed");
	}
	// ------------------------------------------------------------ P10 integrity
	{
		console.log("\nP10: store integrity after everything");
		const { store } = makeEngine("p1");
		const records = store.listAll();
		check("records readable", records.length > 0, String(records.length));
		check("no malformed records", records.every((r) => typeof r.id === "string" && typeof r.state === "string"));
		const p2 = makeEngine("p2").store;
		const tmp = fs.readdirSync(p2.dir()).filter((f) => f.endsWith(".tmp"));
		check("no .tmp leftovers", tmp.length === 0, tmp.join(","));
	}

	console.log(`\n${"=".repeat(52)}`);
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
