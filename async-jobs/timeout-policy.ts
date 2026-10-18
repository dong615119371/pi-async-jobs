/**
 * Command classification and timeout policy.
 *
 * Absorbed from the standalone `global-timeout` extension, which this replaces. Its
 * long-task patterns were worth keeping: they encode real knowledge about which
 * commands are slow, and its quoted-text stripping prevents a command from being
 * misclassified by data inside it (`git commit -m "npm install fix"` is not an install).
 *
 * What changed: the values. The old extension killed a normal command at 3 minutes,
 * which suited a synchronous tool where a stall blocks the turn. These days the same
 * command becomes a background job, nobody is waiting on it, and a 3-minute guillotine
 * would kill perfectly healthy test suites. The tiers are therefore more generous, and
 * serve a different purpose: they are the safety net for a job that hangs, not a limit
 * on how long real work may take.
 */

/** Commands worth waiting longer for: package installs, builds, clones, media work. */
const LONG_TASK_HINTS: RegExp[] = [
	/\b(npm|pnpm|yarn|bun)\s+(i|install|ci|add|update)\b/i,
	/\bpip\d?\s+install\b/i,
	/\b(uv|poetry|conda)\s+(pip\s+)?(install|sync|add)\b/i,
	// Note: `\b-S\b` can never match because `-` is not a word character; do not add \b.
	/\b(apt|apt-get|yum|dnf|zypper|pacman|apk|brew)\b.*?(\b(install|upgrade|update|add|remove)\b|\s-[A-Za-z]*[SU][A-Za-z]*\b)/i,
	/\bwinget\s+install\b/i,
	/\bchoco\s+install\b/i,
	/\bscoop\s+install\b/i,
	/\b(git\s+clone|git\s+fetch|git\s+pull|git\s+push)\b/i,
	/\b(docker|podman)\s+(build|pull|push|compose\s+up)\b/i,
	/\b(cargo|go)\s+(build|install|test)\b/i,
	/\bgradle|mvn\b/i,
	/\b(msbuild|dotnet\s+(build|publish|restore))\b/i,
	/\bcmake\b|\bmake\b|\bninja\b/i,
	/\b(tsc|webpack|vite|rollup|esbuild)\b/i,
	/\b(ffmpeg|yt-dlp|curl|wget)\b/i,
	/\b7z|robocopy|rsync|tar\b/i,
	/\bchkdsk|defrag|dism|sfc\b/i,
	/\b(disk|format|Repair-Volume)\b/i,
	/\b(git\s+gc|git\s+repack)\b/i,
];

/** Already backgrounded by the user's own command, or unclassifiable: do not impose a timeout. */
const SKIP_HINTS: RegExp[] = [
	/\b(Start-Process|Start-Job|nohup|setsid)\b/i,
	/(^|[^&])&\s*$/, // a trailing single `&` (background), but not `&&`
];

/**
 * Kill limits, in seconds.
 *
 * These are hang detectors, not budgets. A background job that runs longer than this is
 * presumed stuck rather than slow.
 */
const TIER = {
	normal: 900, // 15 minutes
	long: 2700, // 45 minutes
} as const;

export interface TimeoutDecision {
	/** Seconds before the job is force-killed. */
	secs: number;
	tier: keyof typeof TIER;
}

/**
 * Strip quoted spans so pattern matching sees the command skeleton only.
 *
 * Without this, `git commit -m "npm install fix"` matches the install pattern and the
 * command is treated as slow. The asymmetry justifies it: missing a slow command costs
 * less than misclassifying a fast one.
 */
export function stripQuoted(s: string): string {
	return s.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, " ");
}

/**
 * Classify a command and return its kill limit.
 *
 * A compound command (`ls && git clone x`) takes the longer tier: the first half may be
 * trivial while the second is genuinely slow, and taking the short limit would kill the
 * clone mid-flight.
 */
export function classifyCommand(command: string): TimeoutDecision | null {
	const skeleton = stripQuoted(command);
	if (SKIP_HINTS.some((re) => re.test(skeleton))) return null;
	if (LONG_TASK_HINTS.some((re) => re.test(skeleton))) return { secs: TIER.long, tier: "long" };
	return { secs: TIER.normal, tier: "normal" };
}

/** Exposed for tests and diagnostics. */
export const TIMEOUT_TIERS = TIER;
