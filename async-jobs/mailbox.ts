/**
 * Session mailbox bridge (PI 侧收件桥).
 *
 * Lets any writer — the `session-mcp` MCP server, another session, a human with
 * `echo` — drop a message into a LIVE pi session from the outside, delivered as a
 * queued follow-up (the Ctrl+Q semantic: never interrupts a running turn).
 *
 * Layout under ~/.pi/agent/mailbox/:
 *   registry/<session-id>.json   one file per live session: {id, name, cwd, pid, ts}
 *                                ts is a 30s heartbeat; a stale ts means the session
 *                                is gone even if shutdown cleanup never ran.
 *   box/<session-id>.jsonl       inbox. One JSON envelope per line:
 *                                {id, from, to, type: "msg"|"ask", body, ts}
 *                                Written by senders with appendFile. Kept after
 *                                delivery, so a session that is offline still receives
 *                                everything queued while it was away (drain on start).
 *   feeds/<session-id>.jsonl     outbox. One line per finished agent run:
 *                                {ts, text, answering: [ask-ids]}
 *                                `answering` links a run's final output to the ask
 *                                envelopes it absorbed, which is what `ask_session`
 *                                on the sender side waits for.
 *
 * Delivery uses pi.sendMessage(..., { deliverAs: "followUp", triggerTurn: true }):
 * "followUp" waits until the agent has no more tool calls — pi's own queue-a-follow-up
 * mechanism — and triggerTurn wakes an idle session. Same batching/storm concerns as
 * job-result delivery do not apply here: envelopes arrive one at a time from a human or
 * an agent on the other end, not from a fan-out of background jobs.
 *
 * This file is a second extension entry of the async-jobs package. It deliberately does
 * not touch the job engine: the mailbox is independent of async mode, and keeping it in
 * its own module graph means a mailbox failure can never take the job host down.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAILBOX_ROOT = path.join(os.homedir(), ".pi", "agent", "mailbox");
const BOX_DIR = path.join(MAILBOX_ROOT, "box");
const FEED_DIR = path.join(MAILBOX_ROOT, "feeds");
const REG_DIR = path.join(MAILBOX_ROOT, "registry");
const HEARTBEAT_MS = 30_000;
const FEED_MAX_BYTES = 1_000_000;

interface Envelope {
	id: string;
	from: string;
	to: string;
	type: "msg" | "ask";
	body: string;
	ts: number;
}

/**
 * File-name safety for session ids (audit finding: a forged id like `..\..\x`
 * escaped the mailbox directory). One shared rule on both sender and bridge side:
 * anything outside [\w.-] collapses to `_`, so every mailbox path stays inside its
 * directory. The raw id is kept in file CONTENT (envelope/registry), never in paths.
 */
export function fileSafe(id: string): string {
	return id.replace(/[^\w.-]+/g, "_");
}

function ensureDirs(): void {
	for (const dir of [MAILBOX_ROOT, BOX_DIR, FEED_DIR, REG_DIR]) {
		fs.mkdirSync(dir, { recursive: true });
	}
}

/** Last assistant text of a run, or "" — tolerant of message shape drift. */
function lastAssistantText(messages: unknown): string {
	if (!Array.isArray(messages)) return "";
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as { role?: string; content?: unknown } | null;
		if (!m || m.role !== "assistant") continue;
		const content = m.content;
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			const texts: string[] = [];
			for (const block of content as Array<{ type?: string; text?: string }>) {
				if (block?.type === "text" && typeof block.text === "string") texts.push(block.text);
			}
			if (texts.length > 0) return texts.join("\n");
		}
	}
	return "";
}

/** Keep the feed bounded: drop everything but the last 100 lines past 1 MB. */
function trimFeed(feedFile: string): void {
	try {
		if (fs.statSync(feedFile).size < FEED_MAX_BYTES) return;
		const lines = fs.readFileSync(feedFile, "utf8").split(/\r?\n/).filter(Boolean);
		fs.writeFileSync(feedFile, lines.slice(-100).join("\n") + "\n");
	} catch {
		/* feed is disposable telemetry; a trim failure is not worth an error */
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		const id = ctx.sessionManager.getSessionId();
		const name = ctx.sessionManager.getSessionName() || id;
		const cwd = ctx.sessionManager.getCwd();

		try {
			ensureDirs();
		} catch {
			return; // no writable home: the bridge stays silent rather than erroring every turn
		}

		const boxName = `${fileSafe(id)}.jsonl`;
		const boxFile = path.join(BOX_DIR, boxName);
		const offsetFile = path.join(BOX_DIR, `${fileSafe(id)}.offset`);
		const feedFile = path.join(FEED_DIR, boxName);
		const regFile = path.join(REG_DIR, `${fileSafe(id)}.json`);

		// The inbox must exist before fs.watch: watching a missing file throws.
		try {
			if (!fs.existsSync(boxFile)) fs.writeFileSync(boxFile, "");
		} catch {
			return;
		}

		// Registry entry doubles as liveness proof for senders.
		const heartbeat = () => {
			try {
				fs.writeFileSync(
					regFile,
					JSON.stringify({ id, name, cwd, pid: process.pid, ts: Date.now() }),
				);
			} catch {
				/* senders treat a missing/stale entry as "session offline" and queue anyway */
			}
		};
		heartbeat();
		const heartbeatTimer = setInterval(heartbeat, HEARTBEAT_MS);
		heartbeatTimer.unref?.();

		// Asks absorbed into a run are answered by that run's final output; the feed
		// entry carries their ids so the waiting ask_session can find its answer.
		const pendingAsks: string[] = [];

		let readOffset = 0;
		try {
			if (fs.existsSync(offsetFile)) {
				readOffset = Math.max(0, Number(fs.readFileSync(offsetFile, "utf8")) || 0);
			}
		} catch {
			readOffset = 0;
		}
		const drainBox = () => {
			let chunk: string;
			try {
				const buf = fs.readFileSync(boxFile);
				if (buf.length < readOffset) readOffset = 0; // someone truncated the inbox
				if (buf.length <= readOffset) return;
				// Boundary safety: only consume up to the last complete newline byte (0x0a).
				// If a concurrent writer wrote a half-line, wait until the newline arrives
				// rather than skipping an unparseable fragment and losing it forever.
				const lastNl = buf.lastIndexOf(0x0a);
				if (lastNl < readOffset) return;
				chunk = buf.slice(readOffset, lastNl + 1).toString("utf8");
				readOffset = lastNl + 1;
				try {
					fs.writeFileSync(offsetFile, String(readOffset));
				} catch {
					/* offset persistence failure falls back to memory offset */
				}
			} catch {
				return;
			}
			for (const line of chunk.split(/\r?\n/)) {
				if (!line.trim()) continue;
				let envelope: Envelope;
				try {
					envelope = JSON.parse(line) as Envelope;
				} catch {
					continue; // one bad line must not block the rest of the queue
				}
				if (typeof envelope?.body !== "string") continue;
				const isAsk = envelope.type === "ask";
				try {
					pi.sendMessage(
						{
							customType: "session-relay",
							content:
								(isAsk
									? `[会话提问 · 来自 ${envelope.from ?? "peer"}，对方在等你的答复]\n`
									: `[会话消息 · 来自 ${envelope.from ?? "peer"}]\n`) + envelope.body,
							display: true,
							details: { envelopeId: envelope.id, from: envelope.from, type: envelope.type },
						},
						{ deliverAs: "followUp", triggerTurn: true },
					);
				} catch {
					continue;
				}
				if (isAsk && envelope.id) pendingAsks.push(envelope.id);
			}
		};

		// Directory-level watch survives inbox recreation on both platforms, and the
		// per-name filter keeps sibling sessions' traffic out of this one's handler.
		// If fs.watch is unavailable or dies later, degrade to a coarse poll instead of
		// never delivering again (audit A finding).
		let watcher: fs.FSWatcher | null = null;
		let watchFallback: ReturnType<typeof setInterval> | null = null;
		const startWatchFallback = () => {
			if (watchFallback !== null) return;
			watchFallback = setInterval(drainBox, 5_000);
			watchFallback.unref?.();
		};
		try {
			watcher = fs.watch(BOX_DIR, (_event, filename) => {
				if (filename && filename !== boxName) return;
				drainBox();
			});
			watcher.on("error", () => {
				try {
					watcher?.close();
				} catch {
					/* already closed */
				}
				watcher = null;
				startWatchFallback();
			});
		} catch {
			watcher = null;
			startWatchFallback();
		}
		// Messages queued while this session was offline are delivered on startup.
		drainBox();

		pi.on("agent_end", (event) => {
			try {
				// FIFO attribution: consume only the oldest pending ask per turn so concurrent
				// asks do not all falsely claim the same turn's output as their own answer.
				const answering = pendingAsks.length > 0 ? [pendingAsks.shift()!] : [];
				fs.appendFileSync(
					feedFile,
					JSON.stringify({
						ts: Date.now(),
						text: lastAssistantText(event.messages),
						answering,
					}) + "\n",
				);
				trimFeed(feedFile);
			} catch {
				/* the asker will time out with a clear error; nothing to recover here */
			}
		});

		pi.on("session_shutdown", () => {
			clearInterval(heartbeatTimer);
			if (watchFallback !== null) clearInterval(watchFallback);
			try {
				watcher?.close();
			} catch {
				/* already closed */
			}
			// Keep the entry instead of deleting it (audit A finding H1): senders need the
			// address to queue mail for the next start. Mark it stopped so liveness reads
			// stale while the address stays resolvable.
			try {
				fs.writeFileSync(
					regFile,
					JSON.stringify({ id, name, cwd, pid: process.pid, ts: Date.now(), stopped: true }),
				);
			} catch {
				/* the old heartbeat timestamp already reads as stale */
			}
		});
	});
}
