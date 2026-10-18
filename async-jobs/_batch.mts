/**
 * Tests for batched delivery.
 *
 * The behaviours that matter: results arriving inside one window are combined, the
 * window is not extended by later arrivals, a single result is not wrapped in batch
 * formatting, and nothing is lost at shutdown.
 */

import { BatchCollector, formatBatch, type BatchItem } from "./batch.ts";

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

interface FakeItem {
	id: string;
}

/** Controllable timers so the window can be advanced deterministically. */
function makeClock() {
	let now = 0;
	const timers: Array<{ at: number; fn: () => void; cancelled: boolean }> = [];
	return {
		setTimeoutFn: (fn: () => void, ms: number) => {
			const handle = { at: now + ms, fn, cancelled: false };
			timers.push(handle);
			return handle;
		},
		clearTimeoutFn: (handle: unknown) => {
			(handle as { cancelled: boolean }).cancelled = true;
		},
		/** Advance time, running anything due. */
		advance(ms: number) {
			now += ms;
			for (const timer of timers) {
				if (!timer.cancelled && timer.at <= now) {
					timer.cancelled = true;
					timer.fn();
				}
			}
		},
	};
}

const render = (item: BatchItem<FakeItem>) => `result of ${item.record.id}`;

console.log("batched delivery\n");

// ------------------------------------------------------------------ B1 combine
{
	console.log("B1: items inside one window are delivered together");
	const clock = makeClock();
	const delivered: Array<Array<BatchItem<FakeItem>>> = [];
	const collector = new BatchCollector<FakeItem>({
		windowMs: 3000,
		deliver: (items) => delivered.push(items),

		setTimeoutFn: clock.setTimeoutFn,
		clearTimeoutFn: clock.clearTimeoutFn,
	});

	collector.add({ record: { id: "a" }, text: "a" });
	check("nothing delivered immediately", delivered.length === 0);
	clock.advance(1000);
	collector.add({ record: { id: "b" }, text: "b" });
	clock.advance(1000);
	collector.add({ record: { id: "c" }, text: "c" });
	check("still holding three", collector.size() === 3);
	check("nothing delivered yet", delivered.length === 0);

	clock.advance(1500); // window (3s from the first add) elapses
	check("delivered once", delivered.length === 1, String(delivered.length));
	check("all three in one batch", delivered[0]?.length === 3, String(delivered[0]?.length));
	check("collector is empty after flush", collector.size() === 0);
}

// --------------------------------------------------------- B2 window not extended
{
	console.log("\nB2: later arrivals do not extend the window");
	const clock = makeClock();
	const delivered: Array<Array<BatchItem<FakeItem>>> = [];
	const collector = new BatchCollector<FakeItem>({
		windowMs: 3000,
		deliver: (items) => delivered.push(items),

		setTimeoutFn: clock.setTimeoutFn,
		clearTimeoutFn: clock.clearTimeoutFn,
	});

	collector.add({ record: { id: "first" }, text: "first" });
	for (let i = 0; i < 5; i++) {
		clock.advance(500);
		collector.add({ record: { id: `late${i}` }, text: "late" }); // keeps arriving
	}
	// 2.5s have passed. The window opened with the first add and closes at 3s, so push
	// past it; arrivals must not have postponed that.
	clock.advance(1000);
	check("batch released despite continuous arrivals", delivered.length >= 1, String(delivered.length));
	const totalDelivered = delivered.reduce((sum, batch) => sum + batch.length, 0);
	check("every item accounted for", totalDelivered === 6, String(totalDelivered));
}

// --------------------------------------------------------- B3 single item plain
{
	console.log("\nB3: a lone result is not wrapped in batch formatting");
	const single = formatBatch([{ record: { id: "only" }, text: "x" }], render);
	check("no batch header for one item", !single.includes("background jobs finished"), single);
	check("content is the item itself", single === "result of only", single);

	const many = formatBatch(
		[
			{ record: { id: "a" }, text: "x" },
			{ record: { id: "b" }, text: "y" },
		],
		render,
	);
	check("header present for several", many.includes("2 background jobs finished"), many);
	check("numbered sections present", many.includes("--- 1/2 ---") && many.includes("--- 2/2 ---"), many);
	check("both bodies present", many.includes("result of a") && many.includes("result of b"), many);
}

// ------------------------------------------------------------- B4 flush on demand
{
	console.log("\nB4: flush releases immediately (shutdown path)");
	const clock = makeClock();
	const delivered: Array<Array<BatchItem<FakeItem>>> = [];
	const collector = new BatchCollector<FakeItem>({
		windowMs: 60000, // long window: only an explicit flush can release it
		deliver: (items) => delivered.push(items),

		setTimeoutFn: clock.setTimeoutFn,
		clearTimeoutFn: clock.clearTimeoutFn,
	});

	collector.add({ record: { id: "x" }, text: "x" });
	check("held", delivered.length === 0 && collector.size() === 1);
	collector.flush();
	check("flush delivers", delivered.length === 1 && delivered[0].length === 1);
	collector.flush();
	check("second flush is a no-op", delivered.length === 1);
}

// ------------------------------------------------------------- B5 empty batch
{
	console.log("\nB5: an empty batch delivers nothing");
	const clock = makeClock();
	let calls = 0;
	const collector = new BatchCollector<FakeItem>({
		windowMs: 1000,
		deliver: () => calls++,

		setTimeoutFn: clock.setTimeoutFn,
		clearTimeoutFn: clock.clearTimeoutFn,
	});
	collector.flush();
	check("no delivery for nothing", calls === 0, String(calls));
	check("formatBatch of empty is empty", formatBatch([], render) === "");
}

// -------------------------------------------------------- B6 window restarts after
{
	console.log("\nB6: a new window opens for items arriving after a flush");
	const clock = makeClock();
	const delivered: Array<Array<BatchItem<FakeItem>>> = [];
	const collector = new BatchCollector<FakeItem>({
		windowMs: 2000,
		deliver: (items) => delivered.push(items),

		setTimeoutFn: clock.setTimeoutFn,
		clearTimeoutFn: clock.clearTimeoutFn,
	});

	collector.add({ record: { id: "batch1-a" }, text: "" });
	clock.advance(2000);
	check("first batch delivered", delivered.length === 1, String(delivered.length));

	collector.add({ record: { id: "batch2-a" }, text: "" });
	check("new window opened", collector.isOpen());
	clock.advance(2000);
	check("second batch delivered separately", delivered.length === 2, String(delivered.length));
	check("batches kept apart", delivered[0][0].record.id === "batch1-a" && delivered[1][0].record.id === "batch2-a");
}

console.log(`\n${"=".repeat(52)}`);
console.log(`PASS ${pass}   FAIL ${fail}`);
// A failing suite must fail the process, or a CI gate reads a red run as green.
process.exitCode = fail > 0 ? 1 : 0;
