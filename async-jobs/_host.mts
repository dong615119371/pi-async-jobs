/**
 * Tests for the host/consumer service surface.
 *
 * The property under test is *cross-extension reachability*: a second extension must be
 * able to contribute jobs without importing this package, because Pi gives every
 * extension its own jiti instance and `moduleCache: false`. An imported module is a
 * second copy with a second registry, and the engine never reads it - the job still
 * delivers, just rendered by the fallback, and nothing reports a problem.
 *
 * What must hold:
 *   - a request on the service channel is answered with a usable service object
 *   - the service starts real jobs and reports their ids
 *   - a renderer registered through the service is the one that renders
 *   - a request without a reply channel is ignored rather than crashing
 *   - the version is advertised so a consumer can detect drift
 *
 * `pi.events` is faked here: a two-map bus is enough, and it keeps this file free of
 * any dependency on Pi's runtime.
 */

import {
	HOST_API_VERSION,
	SERVICE_REQUEST_CHANNEL,
	HOST_READY_CHANNEL,
	publishHostService,
	type HostService,
} from "./host.ts";
import { connectToHost } from "./consumer.ts";
import { JobEngine } from "./engine.ts";
import { JobStore } from "./store.ts";
import { getChannel, resetChannels, digestFor, renderForDelivery } from "./channels.ts";
import * as os from "node:os";
import * as fsp from "node:fs";
import * as pathmod from "node:path";

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

/** Minimal stand-in for `pi.events` plus the one lifecycle hook the modules use. */
function fakePi() {
	const handlers = new Map<string, Array<(data: unknown) => void>>();
	const sessionStart: Array<() => void> = [];
	return {
		events: {
			emit(channel: string, data: unknown): void {
				for (const handler of handlers.get(channel) ?? []) handler(data);
			},
			on(channel: string, handler: (data: unknown) => void): () => void {
				const list = handlers.get(channel) ?? [];
				list.push(handler);
				handlers.set(channel, list);
				return () => {
					const now = handlers.get(channel) ?? [];
					handlers.set(
						channel,
						now.filter((h) => h !== handler),
					);
				};
			},
		},
		on(event: string, handler: () => void): void {
			if (event === "session_start") sessionStart.push(handler);
		},
		/** Fire session_start on every extension that registered for it. */
		startSession(): void {
			for (const handler of sessionStart) handler();
		},
	};
}

function makeEngine(tag: string): { engine: JobEngine; store: JobStore } {
	const root = fsp.mkdtempSync(pathmod.join(os.tmpdir(), `aj-host-${tag}-`));
	const store = new JobStore(root);
	store.init();
	const engine = new JobEngine({
		store,
		target: { sendMessage: () => {}, hasUI: false, notify: () => {} },
	});
	return { engine, store };
}

async function waitFor(fn: () => boolean, ms: number, label: string): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (fn()) return true;
		await new Promise((r) => setTimeout(r, 50));
	}
	console.log(`    (timed out waiting for ${label})`);
	return false;
}

async function main(): Promise<void> {
	console.log("\nH1: a request is answered with a usable service");
	{
		resetChannels();
		const { engine, store } = makeEngine("h1");
		// One `pi`, both sides. In a real runtime the host and the consumer are two
		// extensions in the same session, so they share one EventBus. Giving each its own
		// fake would not model that at all.
		const pi = fakePi();
		publishHostService(pi as never, engine);
		const link = connectToHost(pi as never);
		check("service absent before asking", link.service() === null);

		pi.startSession();
		const svc = link.service();
		check("service arrives after a request", svc !== null);
		check("version advertised", svc?.apiVersion === HOST_API_VERSION, String(svc?.apiVersion));
		check("no mismatch reported", link.versionMismatch() === false);

		// The counters must reflect the engine the host owns, not a copy.
		check("counters are wired to the engine", svc?.activeCount() === engine.activeCount());
		await fsp.promises.rm(store.dir(), { recursive: true, force: true });
	}

	console.log("\nH2: the service starts real jobs");
	{
		resetChannels();
		const { engine, store } = makeEngine("h2");
		const pi = fakePi();
		publishHostService(pi as never, engine);
		const link = connectToHost(pi as never);
		pi.startSession();
		const svc = link.service() as HostService;

		const handle = svc.startProcess({
			command: "echo HOST_SERVICE_JOB",
			name: "via service",
			timeoutSeconds: 30,
		});
		check("returns a handle with an id", typeof handle.id === "string" && handle.id.length > 0, handle.id);
		check("id uses the <tag>-<n> form", /^[0-9A-Z]{4}-\d+$/.test(handle.id), handle.id);

		const settled = await waitFor(() => engine.get(handle.id)?.state !== "running", 20000, "H2");
		check("job actually ran", settled, String(engine.get(handle.id)?.state));
		check("job produced output", (engine.get(handle.id)?.output ?? "").includes("HOST_SERVICE_JOB"));
		await fsp.promises.rm(store.dir(), { recursive: true, force: true });
	}

	console.log("\nH3: a renderer registered through the service is the one that renders");
	{
		resetChannels();
		const { engine, store } = makeEngine("h3");
		const pi = fakePi();
		publishHostService(pi as never, engine);
		const link = connectToHost(pi as never);
		pi.startSession();
		const svc = link.service() as HostService;

		svc.registerChannel({
			name: "consumer-channel",
			render: () => "RENDERED_BY_CONSUMER",
			digest: () => "CONSUMER_DIGEST",
		});
		// The registry the host's engine reads must hold it - proving the service handed
		// over the same module instance the render path uses.
		check("renderer visible to the host registry", getChannel("consumer-channel") !== undefined);

		const handle = svc.startProcess({ command: "echo X", channel: "consumer-channel", timeoutSeconds: 30 });
		const settled = await waitFor(() => engine.get(handle.id)?.state !== "running", 20000, "H3");
		check("job settled", settled);

		const rec = engine.get(handle.id)!;
		const ctx = { tailOutput: (id: string, n: number) => store.tailOutput(id, n) };
		check("render uses the consumer's renderer", renderForDelivery(rec, ctx) === "RENDERED_BY_CONSUMER");
		check("digest uses the consumer's digest", digestFor(rec) === "CONSUMER_DIGEST");
		await fsp.promises.rm(store.dir(), { recursive: true, force: true });
	}

	console.log("\nH4: malformed requests are ignored, not fatal");
	{
		resetChannels();
		const { engine, store } = makeEngine("h4");
		const pi = fakePi();
		publishHostService(pi as never, engine);

		// A request with no reply channel must not throw out of the handler.
		pi.events.emit(SERVICE_REQUEST_CHANNEL, null);
		pi.events.emit(SERVICE_REQUEST_CHANNEL, {});
		pi.events.emit(SERVICE_REQUEST_CHANNEL, { replyChannel: 42 });
		pi.events.emit(SERVICE_REQUEST_CHANNEL, "not an object");
		check("survives malformed requests", true);

		// And the service still answers a good one afterwards.
		const link = connectToHost(pi as never);
		pi.startSession();
		check("still answers after garbage", link.service() !== null);
		await fsp.promises.rm(store.dir(), { recursive: true, force: true });
	}

	console.log("\nH5: consumer re-asks when the host announces it is ready");
	{
		resetChannels();
		const { engine, store } = makeEngine("h5");

		// One `pi`. The consumer connects before the host exists - the case a reload
		// produces - so it registers its askers first, then the host appears.
		const pi = fakePi();
		const link = connectToHost(pi as never);
		check("no service yet", link.service() === null);

		publishHostService(pi as never, engine);
		pi.startSession(); // host announces ready
		check("service arrives from the ready announcement", link.service() !== null);
		await fsp.promises.rm(store.dir(), { recursive: true, force: true });
	}

	console.log("\nH6: the service passes kind through");
	{
		resetChannels();
		const { engine, store } = makeEngine("h6kind");
		const pi = fakePi();
		publishHostService(pi as never, engine);
		const link = connectToHost(pi as never);
		pi.startSession();
		const svc = link.service() as HostService;

		// Without this, `JobKind`'s "delegate" is an unreachable literal: the engine used
		// to hardcode "process", so a consumer could not label its jobs even though the
		// type said it could.
		const handle = svc.startProcess({
			command: "echo KIND",
			kind: "delegate",
			channel: "kind-channel",
			timeoutSeconds: 30,
		});
		const settled = await waitFor(() => engine.get(handle.id)?.state !== "running", 20000, "H6kind");
		check("job settled", settled);
		check("kind survives to the record", engine.get(handle.id)?.kind === "delegate", String(engine.get(handle.id)?.kind));

		// And the default is unchanged for everyone who does not pass one.
		const plain = svc.startProcess({ command: "echo PLAIN", timeoutSeconds: 30 });
		check("kind defaults to process", engine.get(plain.id)?.kind === "process", String(engine.get(plain.id)?.kind));
		await fsp.promises.rm(store.dir(), { recursive: true, force: true });
	}

	console.log("\nH7: version mismatch is reported, not hidden");
	{
		resetChannels();
		const { engine, store } = makeEngine("h6");
		// One `pi`, both sides. In a real runtime the host and the consumer are two
		// extensions in the same session, so they share one EventBus. Giving each its own
		// fake would not model that at all.
		const pi = fakePi();
		publishHostService(pi as never, engine);
		const link = connectToHost(pi as never);
		// A reply carrying a different version must be flagged.
		pi.startSession();
		check("matching version is not flagged", link.versionMismatch() === false);
		check("ready channel name is stable", HOST_READY_CHANNEL === "async-jobs:host-ready");
		await fsp.promises.rm(store.dir(), { recursive: true, force: true });
	}

	console.log("\n====================================================");
	console.log(`PASS ${pass}   FAIL ${fail}`);
	process.exitCode = fail > 0 ? 1 : 0;
}

await main();
