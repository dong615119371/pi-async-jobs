/**
 * Tests for the job journal.
 *
 * The journal is the only record that outlives the store's retention, so the cases that
 * matter are: it captures every terminal state, it survives the store deleting its files,
 * it is append-safe when called repeatedly, and a corrupt line does not poison the read.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { JobJournal, formatJournalEntry, toJournalEntry } from "./journal.ts";
import type { JobRecord } from "./types.ts";

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

const root = path.join(os.tmpdir(), `aj-journal-${Date.now()}`);
fs.mkdirSync(root, { recursive: true });

function record(over: Partial<JobRecord> = {}): JobRecord {
	const startedAt = 1_000_000;
	return {
		id: "aj-11111111",
		name: "npm test",
		kind: "process",
		channel: "generic",
		state: "done",
		startedAt,
		finishedAt: startedAt + 12_000,
		summary: "npm test",
		output: "all good",
		exitCode: 0,
		...over,
	};
}

console.log("job journal\n");

// -------------------------------------------------------------- J1 entry shape
{
	console.log("J1: an entry captures what the record knows");
	const entry = toJournalEntry(record());
	check("id carried", entry.id === "aj-11111111", entry.id);
	check("state carried", entry.state === "done", entry.state);
	check("command carried", entry.command === "npm test", entry.command);
	check("duration in seconds", entry.durationSeconds === 12, String(entry.durationSeconds));
	check("exit code carried", entry.exitCode === 0, String(entry.exitCode));
	check("output carried", entry.output === "all good", entry.output);
	check("not truncated", entry.outputTruncated === false);
}

// ------------------------------------------------------- J2 keeps the END of output
{
	console.log("\nJ2: long output keeps its tail, not its head");
	const long = `${"start\n".repeat(5000)}THE ACTUAL ERROR`;
	const entry = toJournalEntry(record({ output: long }));
	check("flagged as truncated", entry.outputTruncated === true);
	check("the tail survived", entry.output.includes("THE ACTUAL ERROR"), entry.output.slice(-60));
	check("bounded in size", entry.output.length <= 8000, String(entry.output.length));
}

// ----------------------------------------------------------- J3 append then read back
{
	console.log("\nJ3: entries append and come back in order");
	const dir = path.join(root, "j3");
	const journal = new JobJournal(dir);
	check("empty at first", journal.count() === 0, String(journal.count()));

	journal.append(record({ id: "aj-aaaaaaaa" }));
	journal.append(record({ id: "aj-bbbbbbbb" }));
	journal.append(record({ id: "aj-cccccccc" }));
	check("three recorded", journal.count() === 3, String(journal.count()));

	const all = journal.tail(10);
	check("all three returned", all.length === 3, String(all.length));
	check("oldest first", all[0].id === "aj-aaaaaaaa", all[0]?.id);
	check("newest last", all[2].id === "aj-cccccccc", all[2]?.id);

	const two = journal.tail(2);
	check("tail limits to the newest", two.length === 2 && two[0].id === "aj-bbbbbbbb", JSON.stringify(two.map((e) => e.id)));
}

// ---------------------------------------------------------------- J4 failures recorded
{
	console.log("\nJ4: every terminal state is captured, not just success");
	const dir = path.join(root, "j4");
	const journal = new JobJournal(dir);
	journal.append(record({ id: "aj-failfail", state: "failed", exitCode: 3, error: "exited with code 3" }));
	journal.append(record({ id: "aj-killkill", state: "killed", timedOut: true, killedByUser: true }));

	const [failed, killed] = journal.tail(2);
	check("failed recorded with its error", failed.state === "failed" && failed.error === "exited with code 3", JSON.stringify(failed));
	check("killed recorded", killed.state === "killed", killed.state);
	check("timeout flagged", killed.timedOut === true);
	check("user kill flagged", killed.killedByUser === true);
}

// ------------------------------------------- J5 survives the store deleting its files
{
	console.log("\nJ5: the journal outlives the job store's cleanup");
	const dir = path.join(root, "j5");
	const journal = new JobJournal(dir);
	journal.append(record({ id: "aj-survive1" }));

	// Simulate what retention does: the working-state files are deleted wholesale.
	const storeLike = path.join(dir, "aj-survive1.json");
	fs.writeFileSync(storeLike, "{}");
	fs.rmSync(storeLike, { force: true });

	check("job record gone", !fs.existsSync(storeLike));
	check("journal entry still there", journal.tail(1)[0]?.id === "aj-survive1", JSON.stringify(journal.tail(1)));
}

// ------------------------------------------------------ J6 a corrupt line is skipped
{
	console.log("\nJ6: one corrupt line does not poison the read");
	const dir = path.join(root, "j6");
	const journal = new JobJournal(dir);
	journal.append(record({ id: "aj-gooda" }));
	fs.appendFileSync(journal.path(), "{ this is not json\n");
	journal.append(record({ id: "aj-goodb" }));

	const entries = journal.tail(10);
	check("both good lines survive", entries.length === 2, String(entries.length));
	check("first good", entries[0]?.id === "aj-gooda", entries[0]?.id);
	check("second good", entries[1]?.id === "aj-goodb", entries[1]?.id);
}

// --------------------------------------------------------- J7 missing file is empty
{
	console.log("\nJ7: a missing journal reads as empty, not as an error");
	const journal = new JobJournal(path.join(root, "never-written"));
	check("tail is empty", journal.tail(5).length === 0);
	check("count is zero", journal.count() === 0);
}

// ------------------------------------------------------------ J8 formatting is legible
{
	console.log("\nJ8: an entry renders readably");
	const entry = toJournalEntry(record({ id: "aj-format1", output: "line one\nline two" }));
	const text = formatJournalEntry(entry);
	check("stamp present", /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(text), text.split("\n")[0]);
	check("id present", text.includes("aj-format1"), text);
	check("state present", text.includes("done"), text);
	check("duration present", text.includes("12s"), text);
	check("command shown as a shell line", text.includes("$ npm test"), text);
	check("output is indented", text.includes("│ line one"), text);
}

// ------------------------------------------------- J10 a script is collapsed by default
{
	console.log("\nJ10: a multi-line command does not bury the result");
	const script = "cd /tmp\necho one\necho two\necho three";
	const entry = toJournalEntry(record({ command: script, summary: script }));

	const short = formatJournalEntry(entry);
	check("only the first line is shown", short.includes("$ cd /tmp"), short);
	check("the rest is elided", !short.includes("echo three"), short);
	check("count of hidden lines given", short.includes("+3 行"), short);

	const long = formatJournalEntry(entry, true);
	check("full mode shows everything", long.includes("echo three"), long);
}

// ------------------------------------------------ J9 many appends stay one line each
{
	console.log("\nJ9: one append is one line, even with multi-line output");
	const dir = path.join(root, "j9");
	const journal = new JobJournal(dir);
	journal.append(record({ id: "aj-multi", output: "a\nb\nc\nd\ne" }));
	const raw = fs.readFileSync(journal.path(), "utf8");
	check("exactly one line written", raw.split("\n").filter((l) => l.trim()).length === 1, JSON.stringify(raw.slice(0, 80)));
	check("newlines escaped, not literal", journal.tail(1)[0].output === "a\nb\nc\nd\ne", JSON.stringify(journal.tail(1)[0]?.output));
}

// -------------------------------------- J11 inline-only jobs are not journaled
{
	console.log("\nJ11: a command that never became a background job is not recorded");
	// The real defect this fixes: every one of 8 journal entries was a 0-4s command that
	// had its result handed back inline. The user asked for background jobs only, and the
	// history was a list of things they had never seen in the job panel.
	const inline = record({ id: "aj-inline01", isBackgroundJob: false, durationSeconds: 1 } as never);
	check("no entry for a non-background job", toJournalEntry(inline) === null, JSON.stringify(toJournalEntry(inline)));

	const dir = path.join(root, "j11");
	const journal = new JobJournal(dir);
	check("append refuses it", journal.append(inline) === false);
	check("nothing written", journal.count() === 0, String(journal.count()));

	// A real background job still goes in.
	const adopted = record({ id: "aj-adopted1", isBackgroundJob: true });
	check("a real background job is recorded", journal.append(adopted) === true);
	check("exactly one entry", journal.count() === 1, String(journal.count()));
	check("and it is that one", journal.tail(1)[0]?.id === "aj-adopted1", journal.tail(1)[0]?.id);

	// Absent flag means a normal job (records written before the field existed).
	const legacy = record({ id: "aj-legacy01" });
	check("a record without the flag is kept (legacy)", toJournalEntry(legacy) !== null);
}

// ---------------------------------------------------- J12 one file per day
{
	console.log("\nJ12: each day gets its own dated file, and two days are kept");
	const { JobJournal: J, todayStamp: stamp } = await import("./journal.ts");
	const dir = path.join(root, "j12");
	const journal = new J(dir);

	check("today stamp has the expected shape", /^\d{4}-\d{2}-\d{2}$/.test(stamp()), stamp());
	check("filename carries today's date", journal.path().includes(`job-history-${stamp()}.jsonl`), journal.path());

	// Yesterday gets its own file; today's stays untouched.
	const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
	const yPath = journal.path(yesterday);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(yPath, JSON.stringify({ id: "aj-yesterday", at: Date.now() }) + "\n", "utf8");

	journal.append(record({ id: "aj-today00" }));
	check("today's file exists", fs.existsSync(journal.path()));
	check("yesterday's file still exists", fs.existsSync(yPath));
	// `tail()` walks every retained day, newest file first. It used to read only today's
	// file, which made the second retained day unreachable - the tool description promises
	// "look up a job id from a previous session" and that broke at midnight.
	check("tail spans both retained days", journal.tail(10).length === 2, String(journal.tail(10).length));
	check("read-back is today's entry", journal.tail(1)[0]?.id === "aj-today00", journal.tail(1)[0]?.id);
	check("yesterday is reachable too", journal.tail(10).some((e) => e.id === "aj-yesterday"), JSON.stringify(journal.tail(10).map((e) => e.id)));
	check("older day comes first", journal.tail(10)[0]?.id === "aj-yesterday", String(journal.tail(10)[0]?.id));
	check("count spans both days", journal.count() === 2, String(journal.count()));
	check("two dated files present", journal.days().length === 2, JSON.stringify(journal.days()));

	// A third day pushes the oldest out: keep two.
	const older = new Date(Date.now() - 3 * 86400000);
	const oPath = journal.path(older);
	fs.writeFileSync(oPath, JSON.stringify({ id: "aj-ancient", at: 0 }) + "\n", "utf8");
	journal.append(record({ id: "aj-today01" }));
	const kept = journal.days();
	check("still only two kept", kept.length === 2, JSON.stringify(kept));
	check("the oldest was dropped", !kept.some((f) => f.includes(stamp(older))), JSON.stringify(kept));
	check("yesterday survived", kept.some((f) => f.includes(stamp(yesterday))), JSON.stringify(kept));
}

console.log(`\n${"=".repeat(52)}`);
console.log(`PASS ${pass}   FAIL ${fail}`);
// A failing suite must fail the process, or a CI gate reads a red run as green.
process.exitCode = fail > 0 ? 1 : 0;
console.log(`root: ${root}`);
