/**
 * The consumer side of the ecosystem: what an extension writes to contribute jobs.
 *
 * A consumer does not import async-jobs. It cannot: Pi gives each extension its own
 * module graph, so an imported `channels.ts` would be a second copy with a second
 * registry that the engine never reads. Instead it asks over `pi.events`, receives the
 * host's service object, and holds it.
 *
 * Copy this file into your extension (it is small) or depend on the shape via the
 * `HostService` interface below. The interface is the contract; the transport is an
 * implementation detail that may change.
 */

/** Bumped by the host when the shape below changes in a way a consumer could notice. */
export const HOST_API_VERSION = 1;
export const SERVICE_REQUEST_CHANNEL = "async-jobs:request-service";
export const HOST_READY_CHANNEL = "async-jobs:host-ready";

/** Minimal structural types, so a consumer needs no import from the host package. */
export interface JobRecordLike {
	id: string;
	state: "running" | "done" | "failed" | "killed";
	channel: string;
	kind: string;
	summary: string;
	output?: string;
	error?: string;
	startedAt: number;
	finishedAt?: number;
	exitCode?: number;
	stats?: Record<string, number | string>;
}

export interface RenderContextLike {
	/** Tail of the job's output file, already decoded to text. */
	tailOutput: (id: string, maxBytes: number) => { text: string; totalBytes: number };
}

export interface RendererLike {
	/** Channel name. Must match the `channel` you pass to `startProcess`. */
	name: string;
	render: (record: JobRecordLike, ctx: RenderContextLike) => string;
	/** One-line summary for the status list. Falls back to the host's own form. */
	digest?: (record: JobRecordLike) => string;
}

export interface StartOptionsLike {
	command: string;
	name?: string;
	label?: string;
	/** What kind of work this is. Defaults to "process". Nothing routes on it. */
	kind?: string;
	channel?: string;
	timeoutSeconds?: number;
	onSettle?: (record: JobRecordLike) => void;
}

export interface JobHandleLike {
	id: string;
	name: string;
}

export interface HostService {
	apiVersion: number;
	startProcess(options: StartOptionsLike): JobHandleLike;
	registerChannel(renderer: RendererLike): () => void;
	activeCount(): number;
	queuedCount(): number;
}

/** Minimal shape of the Pi extension API this module needs. */
export interface EventsApi {
	events: {
		emit(channel: string, data: unknown): void;
		on(channel: string, data: unknown): () => void;
	};
	on(event: "session_start", handler: () => void): void;
}

/**
 * Ask the host for its service and keep it.
 *
 * Returns an accessor rather than the service itself: the host may load after this
 * extension, and `pi.events` keeps no history, so the reply can arrive later. Calling
 * the accessor before then returns null - callers should treat that as "not available
 * yet" and either wait for the ready event or retry on the next turn.
 *
 * Also re-asks when the host announces it is ready, which covers the reload case where
 * the consumer outlives the host.
 */
export function connectToHost(pi: EventsApi): { service: () => HostService | null; versionMismatch: () => boolean } {
	let current: HostService | null = null;
	let mismatch = false;
	const replyChannel = `async-jobs:service-reply:${Math.random().toString(36).slice(2)}`;

	const accept = (data: unknown) => {
		const payload = data as { service?: HostService } | null;
		const candidate = payload?.service;
		if (!candidate || typeof candidate.startProcess !== "function") return;
		mismatch = candidate.apiVersion !== HOST_API_VERSION;
		current = candidate;
	};

	pi.events.on(replyChannel, accept);
	const ask = () => pi.events.emit(SERVICE_REQUEST_CHANNEL, { replyChannel });
	pi.events.on(HOST_READY_CHANNEL, ask);
	pi.on("session_start", ask);

	return { service: () => current, versionMismatch: () => mismatch };
}
