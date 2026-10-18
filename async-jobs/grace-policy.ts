/**
 * Grace period policy: how long `bash` waits before handing a command to the background.
 *
 * Split out of `managed-bash.ts` for one reason: that file imports the Pi SDK, so nothing in
 * it can be loaded by a test. The decisions that were worth testing - how long to wait, when
 * an estimate should skip the wait entirely, and the note attached to an adopted job - were
 * small pure functions buried inside a tool registration, and therefore had zero coverage.
 * Same move as `timeout-policy.ts`, for the same reason.
 */

/** Default grace period: how long `auto` waits when the caller says nothing. */
export const DEFAULT_GRACE_MS = 20_000;

/**
 * An estimate at or above this is not waited on at all - the command goes straight to the
 * background.
 *
 * This is the backstop that makes `expectSeconds` mean what it should. Without it the number
 * read as "how long I am willing to block", so a caller writing 300 really did stall the turn
 * for five minutes - the exact behaviour this extension exists to remove. The estimate is
 * evidence about the TASK, not a request to wait, and the answer to "this will take 4 minutes"
 * is "then do not block on it".
 *
 * 120s because the two mistakes are not equally bad. Turning a two-minute job into a
 * background job costs one extra round trip; making the user watch an unresponsive screen for
 * two minutes costs two minutes of a turn that looks hung. The cheaper mistake wins, and the
 * line is set where a wait stops feeling like the tool is working and starts feeling like it
 * has stalled.
 *
 * Change this one number to move the line; nothing else depends on the value.
 */
export const DEFER_THRESHOLD_SECONDS = 120;

/** How an estimate was handled, so the reply can explain itself. */
export type GracePlan =
	/** Wait this long, then adopt if still running. */
	| { kind: "wait"; graceMs: number; explicit: boolean }
	/** The estimate was long enough to skip waiting entirely. */
	| { kind: "defer"; expectedSeconds: number };

/**
 * Decide how long to wait for a command.
 *
 * Three outcomes, in order of priority:
 *   1. no usable estimate        -> wait the session default
 *   2. an estimate below the line -> wait exactly that long
 *   3. an estimate at/above it    -> do not wait at all, hand back a job id immediately
 *
 * Non-finite input (NaN, Infinity, a string that slipped through the schema) is treated as
 * absent rather than clamped: `Math.min(x, NaN)` is NaN, and a NaN deadline makes every
 * comparison false, so the wait would become unpredictable. Absent is a safe default; NaN is
 * not.
 *
 * There is deliberately NO upper clamp any more. Clamping conflicted with the threshold: a
 * caller writing 5000 used to be silently rewritten to 300 and then made to wait those 300
 * seconds, which is the worst of both answers. Anything past the threshold now simply does
 * not wait, so there is nothing left to clamp.
 */
export function planGrace(value: unknown, defaultGraceMs: number): GracePlan {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return { kind: "wait", graceMs: Math.max(0, defaultGraceMs), explicit: false };
	}
	const seconds = Math.max(0, value);
	if (seconds >= DEFER_THRESHOLD_SECONDS) {
		return { kind: "defer", expectedSeconds: Math.round(seconds) };
	}
	return { kind: "wait", graceMs: Math.round(seconds * 1000), explicit: true };
}

/**
 * What to say when a command outlived its grace period.
 *
 * The message exists to make the cost of the wait visible. Without a per-call estimate the
 * grace period is a blind guess, and a blind guess that is too short spends its whole length
 * waiting before admitting it - so the caller is told how long that wait was, and, when the
 * length was the default rather than its own choice, how to skip it next time.
 */
export function adoptionNote(graceMs: number, wasExplicit: boolean): string {
	const secs = Math.round(graceMs / 1000);
	if (wasExplicit) return `still running after ${secs}s (your expectSeconds)`;
	// Do NOT say "pass expectSeconds to skip this wait". An estimate above the threshold does
	// skip it, but a small one makes it longer - the advice would be wrong half the time.
	// Point at the one instruction that is always right instead.
	return (
		`still running after ${secs}s (default grace). ` +
		`If a command is known to be slow, mode:"background" skips this wait entirely.`
	);
}

/**
 * What to say when an estimate was long enough to skip waiting.
 *
 * Says outright that nothing was blocked, and repeats the estimate back, so the caller can see
 * that its own number is why the answer came back immediately rather than suspecting a failure.
 */
export function deferNote(expectedSeconds: number): string {
	return (
		`running in the background (you estimated ${String(expectedSeconds)}s, ` +
		`and an estimate of ${String(DEFER_THRESHOLD_SECONDS)}s or more is never waited on). ` +
		`Carry on with other work - the result arrives as a message.`
	);
}
