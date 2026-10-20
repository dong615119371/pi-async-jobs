# pi-async-jobs

> English · [中文](README.md)

<p>
  <img alt="tests" src="https://img.shields.io/badge/assertions-436-brightgreen">
  <img alt="suites" src="https://img.shields.io/badge/suites-11-blue">
  <img alt="version" src="https://img.shields.io/badge/version-0.2.0-orange">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-lightgrey">
  <img alt="platform" src="https://img.shields.io/badge/platform-Windows%20tested-informational">
</p>

Background jobs for Pi's agent loop: a slow command stops holding the whole turn, and its result is delivered later as a message.

> ⚠️ Experimental. This is an architecture exploration, not a production component. Treat it accordingly.
>
> **Most of this code was produced by vibe coding.** Please read it with that in mind.

## The ecosystem

This repository is the **host**. It lends job capability to other extensions, so each one contributes a channel instead of reimplementing a scheduler.

| Package | What it is |
| --- | --- |
| **`pi-async-jobs`** (this repo) | The core: processes, persistence, concurrency, notification, channel registry |
| [`pi-delegate`](https://github.com/dong615119371/pi-delegate) | The first consumer: outsources work to the OpenCode CLI. Ships both a synchronous and an asynchronous tool |

Install either alone, or both:

- This package only → background jobs, no delegation
- Both → background jobs plus synchronous and asynchronous delegation (`delegate_async` activates itself)

Writing a third consumer? See [For other extensions](#for-other-extensions).

## How it works

A long command no longer consumes the time it would take. Wait a configurable grace period; if the command has not returned by then, force it into the background and hand the agent a job id, which frees the agent to continue with work that does not depend on the result.

When the job finishes, its result comes back as a message and wakes the agent again.

```
bash(command)
   │
   ├─ async mode off ──→ Pi's own bash (synchronous, unchanged)
   │
   └─ async mode on
        │
        ├─ finished within grace ──→ result returned inline, turn ends
        │
        └─ past the grace period ──→ persist + return a job id, turn ends
                            │
                    process keeps running
                            │
                ┌─────────┴─────────┐
            finished / failed      job_kill
                │                      │
          3-second window        kill the whole tree
                │                 confirm it is gone
                ↓                      ↓
        wake the agent (new turn)   mark killed
                                    no notice
```

Grace defaults to 20 seconds. `mode: "background"` or `expectSeconds ≥ 120` skips the wait.

## Features

| Feature | Notes |
| --- | --- |
| bash backgrounds itself | With async mode on, a command past the grace period moves to the background and returns a job id |
| `expectSeconds` | An estimate of how long the **task** takes, which decides how long to wait. Kills nothing, limits nothing |
| `mode: "background"` | No wait at all, immediate job id |
| Job persistence | Atomic writes (`.tmp` then rename); jobs left `running` by a previous session are marked `failed` |
| Results are pushed | Finished jobs wake the agent; several are merged into one message on a 3-second window; killed jobs are not announced |
| Four tools | `job_status` / `job_logs` / `job_kill` / `job_history` |
| Channel registry | Renderers are pluggable. Only `generic` is built in; other channels register themselves |
| Process-tree kill | `kill` terminates the whole tree and waits for it to actually exit |

> These tools are **inactive by default**. The `bash` override is always registered, but with async mode off it forwards to Pi's own bash and behaves identically.

## Install

**Installing from git is recommended** — it pins a version:

```bash
pi install git:github.com/dong615119371/pi-async-jobs@v0.2.0
```

Omit `@v0.2.0` to track `main`, if you prefer following development.

You can also copy the `async-jobs/` directory into Pi's extensions directory by hand (location depends on how Pi was installed; see Pi's own docs).

Runtime data lives under `<Pi agent dir>/async-jobs/`:

| File | Contents |
| --- | --- |
| `<id>.json` | Job record (atomic write) |
| `<id>.output` | Job output |
| `job-history-YYYY-MM-DD.jsonl` | Durable history (today and yesterday kept) |
| `mode.json` | Async mode switch |
| `config.json` | Grace period |

## Quick start

Async mode is off by default. Turn it on:

```bash
/async on     # on — the agent can now see the background tools
/async        # current state
/async off    # off — jobs already running are unaffected
```

A worked example. The user asks the agent to run the tests:

```text
User:  run the tests
Agent: bash(command: "pytest -q")
       ↓ grace period expires, command has not returned
         forced to the background, no longer waiting on it
       "Job P3AD-1 is running in the background; the result will come back."

User:  meanwhile, change the install section in the README to npm
Agent: (edits the README, does not need to wait)

       ⋮ a minute later

Agent: (result arrives) Tests finished: 3 failed, 47 passed.
```

The point: once the wait threshold is reached the command is forced into the background and the agent stops waiting on it, so it can do other work that does not need that result. That turn is over; the result arrives in a new one.

How to pass the parameters:

```text
bash(command: "git status")
  → no expectSeconds: wait the default grace (20s), returns normally if it finishes

bash(command: "npm run build", mode: "background")
  → no wait at all, straight to the background

bash(command: "pytest -q", expectSeconds: 45)
  → the agent estimates 45s: wait 45s, then background it if still running
```

Results come back on their own; no polling. To look on purpose:

```text
job_status              # list background jobs (cleanup / verbose)
job_logs P3AD-1         # latest output of one job
job_kill P3AD-1         # stop a job
job_history             # durable history, across sessions
```

Slash commands exist too: `/jobs`, `/job-logs <id>`, `/job-kill <id>`, `/job-history [count]`.

## Tools

| Tool | Purpose | Key parameters |
| --- | --- | --- |
| `job_status` | List this session's background jobs and read results | `jobs` (omit for all), `cleanup` (drop finished records), `verbose` (full result) |
| `job_logs` | Latest output of one job | `id` (unique prefix accepted), `maxBytes` (default 4000). Reads from the tail of the output file |
| `job_kill` | Stop a running job | `id`, `reason`. Kills the whole tree and waits for it to be gone |
| `job_history` | Durable history, oldest first | `count` (default **20**, range 1–200), `id`, `full`. Survives restarts and `/reload` |

`job_status` lists only real background jobs — a command that finished inside the grace period and returned inline is not one.

The `/job-history [count]` slash command defaults to **15**, not the tool's 20.

## expectSeconds

It estimates **task duration**, not "how long the agent is willing to wait".

| Value | Behaviour |
| --- | --- |
| omitted / non-finite | Default grace (20s), backgrounded if still running |
| `x < 120` | Wait x seconds, backgrounded if still running |
| `x ≥ 120` | No wait, immediate job id |

A larger number does not get you the result sooner — it backgrounds the job immediately. Underestimating is safe: the command runs, the result arrives as a message, one extra round trip. So for work you know is long (installs, clones, builds, whole test suites) do not estimate at all; use `mode: "background"`.

## Defaults

| Item | Value |
| --- | --- |
| Grace period | 20s (`graceSeconds` in `config.json`, read on every call) |
| Concurrency | 7 (excess queues and starts as slots free) |
| Kill limit | 15 min normal / 45 min long / **30 min for commands that backgrounded themselves**; an explicit `timeout` wins |

The third tier means the command matched `nohup`, `setsid`, `Start-Process`, `Start-Job`, or a trailing `&` — those get no automatic limit and fall back to 30 minutes.

## Known limitations

- **Developed and verified on Windows only.** Process-tree kill uses `taskkill /T` (then `/F`); shell resolution looks for Git Bash. There are POSIX branches (process-group signals, `/bin/sh`) but they are **untested**.
- **Process-tree kill may leave orphans.** Whether a kill completed depends on a liveness probe; when the probe is unreliable the whole subtree is not guaranteed dead, and the result is marked `leaked`.

## Design notes

**Nothing in Pi's core was changed.** The implementation is a thin application layer, which is also why it is still an architecture exploration.

**Why the tool side and not the loop.** The loop is synchronous on purpose: a tool must return before the agent can generate again. There are only two ways to stop a slow command from blocking — change the loop, or take the waiting out of the tool layer. This takes the second: the process starts as usual and only the *reporting* changes to "here is a job id, the result comes later". Small surface, nothing touched in Pi's core.

**What the channel registry is for.** The framework runs processes, tracks them, kills them, persists them, delivers them — but it does not know what a given channel's output stream looks like. That knowledge belongs to the extension contributing the channel. `channels.ts` lets an extension register `render` / `digest`, and the framework looks them up by `record.channel`. Adding a channel needs no change here; removing a channel extension does not affect the others; a job whose renderer was never registered still delivers through the built-in fallback.

**Why kill waits for the process to actually die.** `child.kill()` signals only the direct child; grandchildren survive. So the whole tree is killed first (`taskkill /T`, then `/F` as a backstop), then a liveness probe confirms the process is really gone — "the signal was sent" and "it is gone" are different claims.

## For other extensions

This package can lend its job capability to another extension, so that extension contributes a channel instead of a second scheduler.

The service travels over `pi.events`, **not** an import. Pi gives each extension its own jiti instance with `moduleCache: false`, so an import resolves to a second copy of the module with a second channel registry — and the engine reads the first. The failure is silent: the job still delivers, just rendered by the fallback.

`consumer.ts` is the template; copy it into your extension. The service surface is four members:

| Member | Purpose |
| --- | --- |
| `startProcess(options)` | Start a background job, get a handle back |
| `registerChannel(renderer)` | Register a renderer for your channel |
| `activeCount()` | Jobs currently holding a slot |
| `queuedCount()` | Jobs waiting for one |

The engine instance is deliberately not handed over — that would hand over `shutdownAll` with it.

**Load order does not matter**: both sides shake hands again on `session_start`, and the host also broadcasts `async-jobs:host-ready`. On a version mismatch the consumer refuses to activate rather than failing later from inside a tool call.

The worked example is [`pi-delegate`](https://github.com/dong615119371/pi-delegate) — the only real consumer of this surface, and therefore the evidence for whether the interface is any good. It registers an `opencode` channel and starts jobs with `kind: "delegate"`.

It demonstrates that the design works: two packages with **separate git repositories, separate versions, separate release cadence**, meeting over `pi.events` at runtime with no compile-time dependency at all.

## Output encoding

A child process emits raw bytes with nothing saying which encoding they are in. Decode wrong and you get mojibake — and mojibake is easy to misdiagnose as something else entirely.

The case that started this:

```
wsl.exe actual output: 未安装适用于 Linux 的 Windows 子系统…
decoded as UTF-8:      *g?[??(u?N  L i n u x  ...
decoded as UTF-16LE:   未安装适用于 Linux 的 Windows 子系统…
```

`wsl.exe` emits UTF-16LE. This was initially mistaken for a shell problem. So UTF-8 cannot be assumed.

### How it decides

No guessing. The same bytes are decoded several ways and the interpretation with the fewest defects wins.

| Candidate | Defects counted |
| --- | --- |
| UTF-8 | `U+FFFD` replacement characters |
| UTF-16LE / UTF-16BE | unpaired surrogates, `U+FFFE`/`U+FFFF`, too few printable characters |
| GBK | `U+FFFD` count |

No lookup tables, and nothing assumed about the language of the content.

### Four details that make it hold up

**One — a partial character at the end is not a defect.** When a chunk is cut mid-character, the last character simply has not arrived. Counting it would make the correct encoding look worse: a 64-byte UTF-8 slice (cut inside a Chinese character) scores 1 defect while GBK scores 0, so the right answer loses.

**Two — UTF-8 with zero defects is decided immediately.** GBK's space is wide enough that almost any byte pair is "valid", so clean UTF-8 also scores zero through GBK. Comparing minimums alone produces a tie and lets GBK win by coincidence. The rule is that clean UTF-8 is not displaced by a tie.

**Three — detection and decoding must use the same alignment offset.** UTF-16 can be off by one byte. `scoreUtf16` returns the offset as well as the score: scoring at offset 1 but decoding from offset 0 gives text that is right for a few characters and then turns to noise.

**Four — defect count has to be read together with printable characters.** A wrong interpretation often has few defects but almost no printable characters either. Defect count alone hands `wsl.exe` to GBK. The score is `defects + max(0, 4 - printable)`; additionally, "no zero bytes *and* decodes cleanly as UTF-8" rules UTF-16 out.

### Why zero bytes fail for Chinese

The textbook approach is "UTF-16 has a zero byte in every odd position":

```
"ABC" UTF-16LE = 41 00 42 00 43 00   ← has zeros, recognisable
"中文" UTF-16LE = 2d 4e 87 65         ← not a single zero
```

Chinese in UTF-16LE is entirely non-zero, so the zero-byte rule fails outright. The zero-byte check is therefore only a **bonus**, not a requirement.

### Streaming output

Pipes read in chunks, and a Chinese character is 3 bytes in UTF-8, so it can be cut in half:

```
chunk1 = E4 B8        ← first two bytes of 中
chunk2 = AD 41 42     ← third byte of 中, then "AB"
```

Decoding `chunk1` alone yields `U+FFFD`, and that error is **unrecoverable** — the bytes have already been decoded wrong. `StreamDecoder` keeps the tail and waits for the next chunk.

UTF-8's partial length is exact: the lead byte declares the sequence length (`110xxxxx` 2 bytes, `1110xxxx` 3, `11110xxx` 4), and a shortfall means a partial character. UTF-16 is simpler: an odd byte count is a partial character.

No conclusion is drawn from the first 32 bytes (`DECIDE_AFTER_BYTES`); with too small a sample every interpretation can look clean. The cost is that the first few dozen bytes of output are delayed, which is invisible in a log.

### Limits

- **Partial GBK characters are not detected.** UTF-8 lets you compute exactly how many bytes are missing; GBK's double bytes carry no such information, so a cut mid-character is indistinguishable from a complete one. A GBK stream cut at a boundary produces replacement characters.
- **Short output under 32 bytes is a gamble.** With too small a sample several interpretations score zero, and the only fallback is "tie goes to UTF-8".
- **A valid GBK byte sequence that also happens to be valid UTF-8 is read as UTF-8.** Unlikely, but not zero — this trades "UTF-8 is by far the most common" for one comparison.

Covers the four encodings actually encountered on Windows, works for Chinese, robust across chunk boundaries. An order of magnitude better than "always UTF-8", two orders of magnitude lighter than pulling in a full encoding-detection library.

## Tests

Eleven test files (`async-jobs/_*.mts`), each run with `node`:

```bash
node async-jobs/_smoke.mts
node async-jobs/_grace.mts
node async-jobs/_gracepolicy.mts
node async-jobs/_batch.mts
node async-jobs/_channels.mts
node async-jobs/_encoding.mts
node async-jobs/_host.mts
node async-jobs/_journal.mts
node async-jobs/_status.mts
node async-jobs/_timeout.mts
node async-jobs/_stress.mts
```

Node must be able to run TypeScript directly (type stripping).

Each file prints `PASS` per assertion and a summary line at the end:

```text
====================================================
PASS 34   FAIL 0
```

Exit code is 0 when everything passes, 1 if anything fails. **436 assertions** across 11 files; `_smoke` and `_stress` take a few minutes because they really spawn processes.

## Contributing

Issues and PRs are welcome.

- Open an issue first for anything substantial, so you do not build in the wrong direction.
- Before submitting, make `async-jobs/_*.mts` pass (see above).
- A bug-fix PR should include how to reproduce it — without a reproduction path I cannot tell whether it is actually fixed.

## License

MIT. See `LICENSE`.
