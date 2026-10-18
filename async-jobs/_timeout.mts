/**
 * Tests for timeout classification (absorbed from the retired global-timeout extension).
 *
 * The classification decides how long a job may run before it is presumed stuck. Two
 * things matter and both are easy to get wrong:
 *   1. a quoted string must not fool the matcher (`git commit -m "npm install x"`);
 *   2. a command that is already backgrounded by its own syntax must not be given a
 *      timeout at all, because we would then kill something the user deliberately
 *      detached.
 */

import { classifyCommand, stripQuoted, TIMEOUT_TIERS } from "./timeout-policy.ts";

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

console.log("timeout classification\n");

// ------------------------------------------------------------ fast commands
console.log("P1: ordinary commands get the normal tier");
for (const cmd of ["ls -la", "git status", "cat file.txt", "echo hi", "grep -r foo ."]) {
	const d = classifyCommand(cmd);
	check(`${cmd} → normal`, d?.tier === "normal", JSON.stringify(d));
}

// ------------------------------------------------------------ slow commands
console.log("\nP2: known slow commands get the long tier");
const slow = [
	"npm install",
	"npm ci",
	"pnpm install --frozen-lockfile",
	"yarn add lodash",
	"pip install requests",
	"git clone https://example.com/repo.git",
	"docker build -t x .",
	"cargo build --release",
	"go test ./...",
	"tsc --build",
	"ffmpeg -i in.mp4 out.mp4",
	"msbuild solution.sln",
	"make all",
];
for (const cmd of slow) {
	const d = classifyCommand(cmd);
	check(`${cmd} → long`, d?.tier === "long", JSON.stringify(d));
}

// --------------------------------------------------- quotes must not mislead
console.log("\nP3: text inside quotes is not the command");
{
	// A commit message mentioning an install is not an install.
	const d = classifyCommand('git commit -m "npm install fix"');
	check('commit mentioning "npm install" stays normal', d?.tier === "normal", JSON.stringify(d));

	const d2 = classifyCommand(`echo "docker build is slow"`);
	check('echo of a slow-looking string stays normal', d2?.tier === "normal", JSON.stringify(d2));

	const d3 = classifyCommand(`git commit -m 'cargo build'`);
	check("single quotes also protected", d3?.tier === "normal", JSON.stringify(d3));
}

// ------------------------------------------ compound commands take the longer
console.log("\nP4: a compound command takes the longer tier");
{
	const d = classifyCommand("ls && git clone https://x/y.git");
	check("ls && git clone → long", d?.tier === "long", JSON.stringify(d));

	const d2 = classifyCommand("cd /tmp; npm install");
	check("cd /tmp; npm install → long", d2?.tier === "long", JSON.stringify(d2));
}

// ------------------------------------------------- deliberately backgrounded
console.log("\nP5: commands the user already backgrounded are left alone");
for (const cmd of ["Start-Process foo", "nohup ./server.sh", "setsid thing", "sleep 5 &"]) {
	check(`${cmd} → no timeout imposed`, classifyCommand(cmd) === null);
}

// --------------------------------------------------------- tiers are generous
console.log("\nP6: tiers leave room for real work");
{
	check("normal tier is at least 10 minutes", TIMEOUT_TIERS.normal >= 600, String(TIMEOUT_TIERS.normal));
	check("long tier is longer than normal", TIMEOUT_TIERS.long > TIMEOUT_TIERS.normal, `${TIMEOUT_TIERS.long} vs ${TIMEOUT_TIERS.normal}`);
	check("long tier is at least 30 minutes", TIMEOUT_TIERS.long >= 1800, String(TIMEOUT_TIERS.long));
}

// ------------------------------------------------------------ stripQuoted API
console.log("\nP7: stripQuoted removes spans but keeps the skeleton");
{
	check("double quotes removed", stripQuoted('a "b c" d') === "a   d", JSON.stringify(stripQuoted('a "b c" d')));
	check("single quotes removed", stripQuoted("a 'b' c") === "a   c", JSON.stringify(stripQuoted("a 'b' c")));
	check("backticks removed", stripQuoted("a `b` c") === "a   c", JSON.stringify(stripQuoted("a `b` c")));
	check("bare command untouched", stripQuoted("npm install") === "npm install");
}

console.log(`\n${"=".repeat(52)}`);
console.log(`PASS ${pass}   FAIL ${fail}`);
// A failing suite must fail the process, or a CI gate reads a red run as green.
process.exitCode = fail > 0 ? 1 : 0;
