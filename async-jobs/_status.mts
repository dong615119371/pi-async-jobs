/**
 * Tests for the background-job display.
 *
 * The display is the user's only signal that work is running, so the cases that matter
 * are: it appears exactly when something is running, it disappears when nothing is, and
 * a hostile command line cannot break the layout.
 */

import { buildWidgetLines, formatElapsed, formatFooter, sanitizeLabel, widgetSignature } from "./status-line.ts";
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

function job(id: string, name: string, startedAt: number): JobRecord {
	return {
		id,
		name,
		kind: "process",
		channel: "generic",
		state: "running",
		startedAt,
		summary: name,
	};
}

console.log("background-job display\n");

// ------------------------------------------------------------- D1 elapsed format
{
	console.log("D1: elapsed time is compact and fixed-width-ish");
	check("zero", formatElapsed(0) === "0s", formatElapsed(0));
	check("under a minute", formatElapsed(9_400) === "9s", formatElapsed(9_400));
	check("rounds down", formatElapsed(1_999) === "1s", formatElapsed(1_999));
	check("exactly a minute", formatElapsed(60_000) === "1m00s", formatElapsed(60_000));
	check("minutes and seconds", formatElapsed(192_000) === "3m12s", formatElapsed(192_000));
	check("seconds are zero-padded", formatElapsed(125_000) === "2m05s", formatElapsed(125_000));
	check("an hour", formatElapsed(3_600_000) === "1h00m", formatElapsed(3_600_000));
	check("hours and minutes", formatElapsed(3_930_000) === "1h05m", formatElapsed(3_930_000));
	check("negative clamps to zero", formatElapsed(-5_000) === "0s", formatElapsed(-5_000));
}

// ------------------------------------------------------------- D2 label sanitation
{
	console.log("\nD2: a multi-line command cannot break the layout");
	const script = "for i in 1 2 3\ndo\n  echo $i\ndone";
	const flat = sanitizeLabel(script);
	check("no newlines survive", !flat.includes("\n"), JSON.stringify(flat));
	check("content preserved flat", flat.startsWith("for i in 1 2 3"), flat);

	const tabs = sanitizeLabel("a\tb   c");
	check("tabs and runs collapse to one space", tabs === "a b c", JSON.stringify(tabs));

	const long = sanitizeLabel("x".repeat(200));
	check("truncated to the limit", long.length <= 60, String(long.length));
	check("truncation is visible", long.endsWith("…"), long.slice(-3));

	const exact = sanitizeLabel("y".repeat(60));
	check("exactly at the limit is untouched", exact.length === 60 && !exact.includes("…"), String(exact.length));
}

// --------------------------------------------------------------- D3 footer text
{
	console.log("\nD3: the footer says what is running");
	check("nothing running is empty", formatFooter(0, 0) === "", formatFooter(0, 0));
	check("one job", formatFooter(1, 0) === "1 个作业运行中", formatFooter(1, 0));
	check("several jobs", formatFooter(3, 0) === "3 个作业运行中", formatFooter(3, 0));
	check("queued shown", formatFooter(2, 4) === "2 个作业运行中，4 个排队", formatFooter(2, 4));
	check("only queued", formatFooter(0, 1) === "0 个作业运行中，1 个排队", formatFooter(0, 1));
}

// --------------------------------------------------------------- D4 widget lines
{
	console.log("\nD4: the widget lists each job");
	const now = 1_000_000;
	const lines = buildWidgetLines(
		[
			job("aj-11111111", "npm test", now - 9_000),
			job("aj-22222222", "sleep 300", now - 192_000),
		],
		now,
	);
	check("heading present", lines[0].includes("后台作业 2 个"), lines[0]);
	check("one line per job", lines.length === 3, String(lines.length));
	check("id shown", lines[1].includes("aj-11111111"), lines[1]);
	check("elapsed shown", lines[1].includes("9s"), lines[1]);
	check("label shown", lines[1].includes("npm test"), lines[1]);
	check("second job elapsed", lines[2].includes("3m12s"), lines[2]);
}

// ------------------------------------------------------------ D5 empty = no lines
{
	console.log("\nD5: nothing running means nothing displayed");
	const lines = buildWidgetLines([], Date.now());
	check("empty array, not a stub", lines.length === 0, JSON.stringify(lines));
	check("signature is empty", widgetSignature([]) === "", widgetSignature([]));
}

// ------------------------------------------------------------ D6 singular heading
{
	console.log("\nD6: one job reads naturally");
	const lines = buildWidgetLines([job("aj-aaaaaaaa", "make", 0)], 5_000);
	check("heading", lines[0].includes("后台作业 1 个"), lines[0]);
	check("does not say '1 jobs'", !lines[0].includes("background"), lines[0]);
	check("only two lines", lines.length === 2, String(lines.length));
}

// ------------------------------------------------------------ D7 queued jobs
{
	console.log("\nD7: queued jobs are marked, not claimed as executing");
	const now = 10_000;
	const waiting = new Set(["aj-bbbbbbbb"]);
	const lines = buildWidgetLines(
		[job("aj-aaaaaaaa", "first", now - 5_000), job("aj-bbbbbbbb", "second", now - 5_000)],
		now,
		waiting,
	);
	check("heading counts the queue", lines[0].includes("1 个排队中"), lines[0]);
	check("still lists both", lines.length === 3, String(lines.length));
	check("executing row has a ticker", /^\s+\* aj-aaaaaaaa\s+5s/.test(lines[1]), JSON.stringify(lines[1]));
	check("queued row says queued, not an elapsed time", lines[2].includes("排队中"), JSON.stringify(lines[2]));
	check("queued row has no ticker", !lines[2].includes("*"), JSON.stringify(lines[2]));

	const plain = buildWidgetLines([job("aj-bbbbbbbb", "x", 0)], 1_000);
	check("no queue means no mention", !plain[0].includes("排队"), plain[0]);
}

// ------------------------------------------------------- D8 signature detects change
{
	console.log("\nD8: the signature changes when the display should");
	const a = buildWidgetLines([job("aj-cccccccc", "x", 0)], 1_000);
	const b = buildWidgetLines([job("aj-cccccccc", "x", 0)], 2_000);
	check("a ticking clock changes it", widgetSignature(a) !== widgetSignature(b), widgetSignature(a));
	const again = buildWidgetLines([job("aj-cccccccc", "x", 0)], 1_000);
	check("identical frames match", widgetSignature(a) === widgetSignature(again));
}

// ------------------------------------------------------ D9 layout survives hostile text
{
	console.log("\nD9: hostile command text does not corrupt the frame");
	const nasty = job("aj-dddddddd", "echo \"a\nb\" && rm -rf / \t --flag", 0);
	const lines = buildWidgetLines([nasty], 1_000);
	check("still exactly two lines", lines.length === 2, JSON.stringify(lines));
	check("no embedded newline in the row", !lines[1].includes("\n"), JSON.stringify(lines[1]));
	check("row starts with the marker and id", lines[1].trimStart().startsWith("* aj-dddddddd"), lines[1]);
}

// ------------------------------------------------------ D10 CJK column alignment
{
	console.log("\nD10: Chinese text still lines up (wide characters are two columns)");
	const now = 100_000;
	const lines = buildWidgetLines(
		[job("aj-eeeeeeee", "npm test", now - 104_000), job("aj-ffffffff", "cargo build", now - 8_000)],
		now,
		new Set(["aj-ffffffff"]),
	);
	// The label must start at the same column on both rows, even though one row's state
	// cell is "1m44s" (5 chars) and the other's is "排队中" (3 chars, 6 columns).
	const labelColumn = (line: string) => {
		const idx = line.indexOf(line.includes("npm test") ? "npm test" : "cargo build");
		let width = 0;
		for (const ch of line.slice(0, idx)) width += /[\u2e80-\ua4cf\uff00-\uff60]/.test(ch) ? 2 : 1;
		return width;
	};
	check("labels start at the same column", labelColumn(lines[1]) === labelColumn(lines[2]),
		`${labelColumn(lines[1])} vs ${labelColumn(lines[2])}`);
	check("queued row is marked differently", lines[2].includes("-") && !lines[2].includes("*"), lines[2]);
}

console.log(`\n${"=".repeat(52)}`);
console.log(`PASS ${pass}   FAIL ${fail}`);
// A failing suite must fail the process, or a CI gate reads a red run as green.
process.exitCode = fail > 0 ? 1 : 0;
