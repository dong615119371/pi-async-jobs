/**
 * Tests for the channel registry.
 *
 * The property under test is *independence*: this package must be able to deliver a
 * result without knowing anything about the extension that produced it. Every assertion
 * below exists because a hardcoded `record.channel === "custom"` branch used to sit in
 * the delivery path, which made the framework depend on another extension's module.
 *
 * What must hold:
 *   - a registered channel's renderer is used
 *   - an unregistered channel still delivers, via the fallback
 *   - a renderer that throws does not lose the result
 *   - re-registering replaces rather than stacks (extension reload)
 *   - unregister removes only its own entry
 */

import {
	registerChannel,
	getChannel,
	registeredChannels,
	renderForDelivery,
	renderAndPersist,
	digestFor,
	resetChannels,
} from "./channels.ts";
import { JobStore } from "./store.ts";
import { JobEngine } from "./engine.ts";
import * as os from "node:os";
import * as fsp from "node:fs";
import * as pathmod from "node:path";
import type { JobRecord, ChannelRenderContext } from "./types.ts";

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

function record(over: Partial<JobRecord> = {}): JobRecord {
	return {
		id: "aj-test",
		name: "t",
		kind: "process",
		channel: "generic",
		state: "done",
		startedAt: 1000,
		finishedAt: 3000,
		summary: "echo hi",
		output: "hello",
		...over,
	};
}

const ctx: ChannelRenderContext = {
	tailOutput: () => ({ text: "", totalBytes: 0 }),
};

console.log("\nC1: no channel registered - fallback still delivers");
resetChannels();
{
	const text = renderForDelivery(record(), ctx);
	check("fallback mentions the job id", text.includes("aj-test"), text);
	check("fallback includes the output", text.includes("hello"), text);
	check("nothing is registered", registeredChannels().length === 0);

	const failed = renderForDelivery(record({ state: "failed", output: undefined, error: "boom" }), ctx);
	check("fallback surfaces the error", failed.includes("boom"), failed);

	const empty = renderForDelivery(record({ output: undefined }), ctx);
	check("fallback never returns an empty body", empty.includes("(no output)"), empty);
}

console.log("\nC2: a registered channel owns its own rendering");
resetChannels();
{
	const off = registerChannel({
		name: "custom",
		render: (r) => `[custom ${r.id}] ok`,
	});
	check("is registered", getChannel("custom") !== undefined);
	const text = renderForDelivery(record({ channel: "custom" }), ctx);
	check("uses the registered renderer", text === "[custom aj-test] ok", text);
	check("does not fall back for other channels", renderForDelivery(record(), ctx).includes("hello"));
	off();
}

console.log("\nC3: a throwing renderer must not lose the result");
resetChannels();
{
	registerChannel({
		name: "boom",
		render: () => {
			throw new Error("renderer exploded");
		},
	});
	// The delivery callback in index.ts is inside notifyFinish, which swallows exceptions.
	// A thrown renderer would therefore drop the result silently - the exact failure this
	// whole audit was about. Falling back is always better than losing the answer.
	const text = renderForDelivery(record({ channel: "boom" }), ctx);
	check("falls back instead of throwing", text.includes("hello"), text);
	check("still identifies the job", text.includes("aj-test"), text);
}

console.log("\nC4: digest falls back when a channel has no digest");
resetChannels();
{
	registerChannel({ name: "nodigest", render: () => "x" });
	const d = digestFor(record({ channel: "nodigest" }));
	check("generic digest names the state", d.includes("done"), d);

	registerChannel({
		name: "custom",
		digest: () => "done, 3 tool calls  (custom channel summary)",
		render: () => "x",
	});
	const d2 = digestFor(record({ channel: "custom", stats: { toolCalls: 3 } }));
	check("registered digest is used", d2.includes("3 tool calls"), d2);

	registerChannel({
		name: "throwdigest",
		digest: () => {
			throw new Error("nope");
		},
		render: () => "x",
	});
	const d3 = digestFor(record({ channel: "throwdigest" }));
	check("throwing digest falls back", d3.includes("done"), d3);
}

console.log("\nC5: reload replaces instead of stacking");
resetChannels();
{
	registerChannel({ name: "custom", render: () => "first" });
	registerChannel({ name: "custom", render: () => "second" });
	check("only one entry remains", registeredChannels().length === 1, String(registeredChannels().length));
	const text = renderForDelivery(record({ channel: "custom" }), ctx);
	check("the newest renderer wins", text === "second", text);
}

console.log("\nC6: unregister removes only its own entry");
resetChannels();
{
	const offA = registerChannel({ name: "a", render: () => "A" });
	const offB = registerChannel({ name: "b", render: () => "B" });
	offA();
	check("a is gone", getChannel("a") === undefined);
	check("b survives", getChannel("b") !== undefined);
	offB();
	check("b removed on its own handle", getChannel("b") === undefined);
}

console.log("\nC7: stale handle must not evict a newer registration");
resetChannels();
{
	const stale = registerChannel({ name: "custom", render: () => "old" });
	// Extension reload: a fresh registration replaces the old one...
	registerChannel({ name: "custom", render: () => "new" });
	// ...and the old instance's shutdown must not then delete the new entry.
	stale();
	check("newer registration survives the stale unregister", getChannel("custom") !== undefined);
	const text = renderForDelivery(record({ channel: "custom" }), ctx);
	check("and it is still the new one", text === "new", text);
}

console.log("\nC8: a channel name is opaque to the framework");
resetChannels();
{
	// The framework must not carry a closed list of names. Anything an extension invents
	// has to work without editing this package.
	const unregister = registerChannel({
		name: "some-future-channel",
		render: (r) => `[${r.id}] future`,
	});
	const text = renderForDelivery(record({ channel: "some-future-channel" }), ctx);
	check("unknown-to-the-framework name works", text === "[aj-test] future", text);
	unregister();
}

// -------------------------------------------------------------------------
// The three edits below were made after an audit found real defects. Each one is
// locked here because the first round of review proved the bug, then proved the
// fix - and then a second round pointed out that a green suite is NOT evidence a
// fix works unless an assertion covers it. These exist for that reason.
// -------------------------------------------------------------------------

console.log("\nC9: the digest gate must key on `digest`, not on `render` (P1)");
resetChannels();
{
	// The defect: `generic` registers a renderer WITHOUT a digest. An earlier gate
	// tested `getChannel(record.channel)`, which is truthy for generic, so generic
	// jobs were routed into `digestFor` and came back as a bare `done (exit 0)` -
	// losing the size+first-line summary a model uses to decide whether to open
	// job_logs. The gate must ask a different question.
	registerChannel({ name: "generic", render: (r) => r.output ?? "" });
	const generic = getChannel("generic");
	check("generic has a renderer", generic !== undefined);
	check("generic has NO digest", generic?.digest === undefined);
	check(
		"the gate's predicate is therefore false for generic",
		!getChannel("generic")?.digest,
	);

	registerChannel({
		name: "custom",
		render: () => "x",
		digest: () => "done, 3 tool calls",
	});
	check(
		"the gate's predicate is true only for channels that registered a digest",
		typeof getChannel("custom")?.digest === "function",
	);
	check("digestFor still works for them", digestFor(record({ channel: "custom" })).includes("tool calls"));
}

console.log("\nC10: an empty render/digest must fall back, not vanish (P4)");
resetChannels();
{
	// The defect: the try/catch covered a THROW, but not an empty return. A renderer
	// returning "" produced a blank result that looked identical to a job that said
	// nothing - the same failure mode as the empty-output bug this extension was
	// audited for. An empty string is a loss; fall back instead.
	registerChannel({
		name: "blank",
		render: () => "",
		digest: () => "",
	});
	const text = renderForDelivery(record({ channel: "blank" }), ctx);
	check("empty render falls back to the plain form", text.includes("hello"), JSON.stringify(text));
	check("and still names the job", text.includes("aj-test"), text);

	const d = digestFor(record({ channel: "blank" }));
	check("empty digest falls back to state+exit", d.includes("done"), d);
	check("and it is not empty", d.length > 0, JSON.stringify(d));
}

console.log("\nC11: renderer-written stats must survive to disk (P2)");
{
	// The defect: `engine.finish` writes the record to disk BEFORE the delivery
	// callback runs, and the callback is what invokes the renderer. The renderer
	// writes facts back (a channel may keep session id and tool-call count
	// in `record.stats`), so those facts existed only in memory and vanished on the
	// next session - the digest's "N tool calls" went to 0 after a restart.
	//
	// The fix is `renderAndPersist`: render, then persist. Asserting it here pins the
	// ORDER, not just "store.write keeps stats" - the ordering is the whole bug.
	const root = fsp.mkdtempSync(pathmod.join(os.tmpdir(), "aj-stats-"));
	const store = new JobStore(root);

	const rec = record({ id: "aj-stats", channel: "custom", state: "done", output: "{}" });
	// Simulate `engine.finish`'s write: the record lands on disk with no stats yet.
	store.write(rec);
	check("engine's first write has no stats", store.read("aj-stats")?.stats === undefined);

	// The renderer writes back, exactly as a channel renderer does.
	registerChannel({
		name: "custom",
		render: (r) => {
			const stats = (r.stats ??= {});
			stats.sessionID = "ses_probe";
			stats.cost = 0.5;
			stats.toolCalls = 7;
			return "[custom channel rendered]";
		},
	});

	// Call the real function under test. If it forgets the persist step, these fail.
	const writes: string[] = [];
	const text = renderAndPersist(
		rec,
		{ tailOutput: () => ({ text: "", totalBytes: 0 }) },
		(r) => {
			writes.push(r.id);
			store.write(r);
		},
	);
	check("rendering happened", text.includes("rendered"), text);
	check("the record was persisted exactly once", writes.length === 1, writes.join(","));

	const back = store.read("aj-stats");
	check("the persist step wrote stats to disk", back?.stats !== undefined);
	check("session id survives", back?.stats?.sessionID === "ses_probe", JSON.stringify(back?.stats));
	check("tool calls survive", back?.stats?.toolCalls === 7, JSON.stringify(back?.stats));
	check("cost survives", back?.stats?.cost === 0.5, JSON.stringify(back?.stats));
	check(
		"digest can read tool calls from a rehydrated record",
		Number(back?.stats?.toolCalls ?? 0) === 7,
	);

	// A renderer that throws must still persist the record: losing the stats is better
	// than losing the whole result, and the fallback text must still go out.
	registerChannel({
		name: "custom",
		render: () => {
			throw new Error("boom");
		},
	});
	let persistedAfterThrow = false;
	const text2 = renderAndPersist(
		rec,
		{ tailOutput: () => ({ text: "", totalBytes: 0 }) },
		() => {
			persistedAfterThrow = true;
		},
	);
	check("a throwing renderer still persists", persistedAfterThrow);
	check("and still delivers something", text2.length > 0, JSON.stringify(text2));

	try {
		fsp.rmSync(root, { recursive: true, force: true });
	} catch {
		/* leaving the dir behind is not a test failure */
	}
}

resetChannels();


console.log("\nC12: a non-generic channel survives the engine end to end");
{
	// The gaps this closes: every suite passes `startProcess` without a channel, so
	// `engine.ts`'s `options.channel ?? "generic"` plumbing was never exercised for a
	// named channel. `_channels.mts` covers renderers, but with records built by hand -
	// never with one the engine itself produced. Audited as a blind spot (R4).
	const root2 = fsp.mkdtempSync(pathmod.join(os.tmpdir(), "aj-chan-"));
	const store2 = new JobStore(root2);
	const engine = new JobEngine({ store: store2 });

	registerChannel({
		name: "custom",
		render: (r) => `[via ${r.channel}] ${r.output ?? ""}`,
		digest: (r) => `${r.state} via ${r.channel}`,
	});

	const handle = engine.startProcess({
		command: "echo CHANNEL_OK",
		name: "chan-test",
		channel: "custom",
		timeoutSeconds: 30,
	});
	check("record carries the channel name", handle.record.channel === "custom", handle.record.channel);

	// Wait for it to settle, then render through the registry the way delivery does.
	await new Promise((r) => setTimeout(r, 1500));
	const settled = store2.read(handle.id);
	check("job settled", settled?.state === "done", String(settled?.state));
	check("channel survived to the record", settled?.channel === "custom", String(settled?.channel));

	const text = renderAndPersist(
		settled!,
		{ tailOutput: (id, maxBytes) => store2.tailOutput(id, maxBytes) },
		(r) => store2.write(r),
	);
	check("named channel's renderer was used", text.includes("[via custom]"), text.slice(0, 80));
	check("digest routes by channel too", digestFor(settled!).includes("via custom"), digestFor(settled!));

	try {
		fsp.rmSync(root2, { recursive: true, force: true });
	} catch {
		/* leaving the dir behind is not a test failure */
	}
}

console.log(`\nPASS ${pass}   FAIL ${fail}`);
process.exitCode = fail > 0 ? 1 : 0;
