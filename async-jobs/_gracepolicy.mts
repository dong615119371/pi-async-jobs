/**
 * Tests for the grace-period policy.
 *
 * These exist because the policy was previously unreachable: it lived inside a tool
 * registration in `managed-bash.ts`, which imports the Pi SDK, so no test could load it.
 * Everything here guards a decision a model can actually trip over - how long an estimate
 * makes the tool wait, when it should stop waiting entirely, and what it is told either way.
 */

import {
	DEFAULT_GRACE_MS,
	DEFER_THRESHOLD_SECONDS,
	adoptionNote,
	deferNote,
	planGrace,
} from "./grace-policy.ts";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ""): void {
	if (ok) {
		pass++;
		console.log(`  PASS  ${name}`);
	} else {
		fail++;
		console.log(`  FAIL  ${name}${detail ? `  (${detail})` : ""}`);
	}
}

function main(): void {
	// ------------------------------------------------------- P1 no estimate given
	//
	// Absent must mean "use the session default", never "wait zero". A zero would turn every
	// ordinary bash call into an instant background job.
	{
		console.log("\nP1: no estimate means the session default");
		for (const [label, value] of [
			["undefined", undefined],
			["null", null],
			["a string", "30"],
			["an object", {}],
			["true", true],
		] as const) {
			const plan = planGrace(value, 20_000);
			check(
				`${label} -> default wait`,
				plan.kind === "wait" && plan.graceMs === 20_000 && plan.explicit === false,
				JSON.stringify(plan),
			);
		}
	}

	// ------------------------------------------------------- P2 non-finite input
	//
	// NaN is the dangerous one: `Math.min(x, NaN)` is NaN, and a NaN deadline makes every
	// comparison false, so the wait becomes unpredictable rather than falling back.
	{
		console.log("\nP2: non-finite numbers fall back instead of poisoning the deadline");
		for (const [label, value] of [
			["NaN", Number.NaN],
			["Infinity", Number.POSITIVE_INFINITY],
			["-Infinity", Number.NEGATIVE_INFINITY],
		] as const) {
			const plan = planGrace(value, 20_000);
			check(`${label} -> default wait`, plan.kind === "wait" && plan.graceMs === 20_000, JSON.stringify(plan));
		}
	}

	// -------------------------------------------------- P3 short estimates are waited
	{
		console.log("\nP3: a short estimate sets the wait exactly");
		const cases: Array<[number, number]> = [
			[3, 3000],
			[0.5, 500],
			[0, 0],
			[45, 45_000],
		];
		for (const [secs, ms] of cases) {
			const plan = planGrace(secs, 20_000);
			check(
				`${String(secs)}s -> ${String(ms)}ms`,
				plan.kind === "wait" && plan.graceMs === ms && plan.explicit === true,
				JSON.stringify(plan),
			);
		}
		check("negative floors at 0", (() => {
			const plan = planGrace(-10, 20_000);
			return plan.kind === "wait" && plan.graceMs === 0;
		})());
	}

	// ------------------------------------------------------ P4 the defer threshold
	//
	// This is the backstop under the whole design: an estimate is evidence about the task,
	// not a request to block. At or above the threshold the command must NOT be waited on.
	{
		console.log("\nP4: a long estimate is not waited on at all");
		for (const secs of [DEFER_THRESHOLD_SECONDS, 300, 5000, 1e9]) {
			const plan = planGrace(secs, 20_000);
			check(`${String(secs)}s -> deferred`, plan.kind === "defer", JSON.stringify(plan));
		}
		// Just below the line still waits - the boundary must not be off by one.
		const justUnder = planGrace(DEFER_THRESHOLD_SECONDS - 1, 20_000);
		check(
			`${String(DEFER_THRESHOLD_SECONDS - 1)}s still waits`,
			justUnder.kind === "wait" && justUnder.graceMs === (DEFER_THRESHOLD_SECONDS - 1) * 1000,
			JSON.stringify(justUnder),
		);

		// The reported estimate is echoed back so the reply can explain itself.
		const long = planGrace(300, 20_000);
		check("defer echoes the estimate", long.kind === "defer" && long.expectedSeconds === 300, JSON.stringify(long));
	}

	// ----------------------------------- P5 a huge value is deferred, not truncated
	//
	// The old code silently clamped 5000 to 300 and then waited those 300 seconds - the worst
	// of both answers. Deferring is the point of removing the clamp.
	{
		console.log("\nP5: absurd values defer instead of being clamped into a long wait");
		const plan = planGrace(5000, 20_000);
		check("5000s does not wait", plan.kind === "defer", JSON.stringify(plan));
		check("no 300s wait is invented", plan.kind !== "wait");
	}

	// -------------------------------------------------------- P6 the threshold value
	{
		console.log("\nP6: the threshold is the documented one");
		check("120 seconds", DEFER_THRESHOLD_SECONDS === 120, String(DEFER_THRESHOLD_SECONDS));
		check("default is 20s", DEFAULT_GRACE_MS === 20_000, String(DEFAULT_GRACE_MS));
		check("default is below the threshold", DEFAULT_GRACE_MS / 1000 < DEFER_THRESHOLD_SECONDS);
	}

	// -------------------------------------------------------------- P7 the notes
	{
		console.log("\nP7: the adoption note distinguishes a default wait from a chosen one");
		const def = adoptionNote(20_000, false);
		check("default mentions the wait length", def.includes("20s"), def);
		check("default says it was the default", def.includes("default grace"), def);
		// Must NOT recommend `expectSeconds` here: a small estimate makes the wait LONGER, so
		// that advice would be wrong half the time. `mode:"background"` is always correct.
		check("default points at the always-correct escape", def.includes("background"), def);
		check("default does not recommend a longer wait", !def.includes("expectSeconds"), def);

		const own = adoptionNote(45_000, true);
		check("explicit mentions the wait length", own.includes("45s"), own);
		check("explicit credits the estimate", own.includes("your expectSeconds"), own);
		check("explicit does not scold about a default", !own.includes("default grace"), own);
		check("zero reads sensibly", adoptionNote(0, true) === "still running after 0s (your expectSeconds)", adoptionNote(0, true));

		const deferred = deferNote(300);
		check("defer says it is in the background", deferred.includes("background"), deferred);
		check("defer echoes the estimate", deferred.includes("300s"), deferred);
		check("defer names the threshold", deferred.includes(String(DEFER_THRESHOLD_SECONDS)), deferred);
		check("defer tells the model not to wait", deferred.includes("Carry on"), deferred);
	}

	console.log(`\n${"=".repeat(50)}`);
	console.log(`PASS ${pass}   FAIL ${fail}`);
	process.exitCode = fail > 0 ? 1 : 0;
}

main();
