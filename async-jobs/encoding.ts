/**
 * Output decoding for job streams.
 *
 * A child process's output is a byte stream, and Windows tools are inconsistent about
 * how they encode it. Decoding everything as UTF-8 - the obvious thing, and what this
 * code used to do - turns common output into mojibake:
 *
 *   wsl.exe:    "未安装适用于 Linux 的 Windows 子系统..."
 *   as utf8:    "*g?[??(u?N  L i n u x  ..."      (unreadable)
 *   as utf16le: the correct text
 *
 * That exact case appeared in this project's own tool output and was mistaken for a
 * shell problem. It is an encoding problem: `wsl.exe` emits UTF-16LE.
 *
 * Detection is score-based rather than pattern-based, because the obvious patterns lie.
 * Deciding "UTF-16 needs a zero byte in every odd position" works for ASCII text but
 * fails completely for Chinese text, whose UTF-16LE bytes are all non-zero:
 *
 *   "中文" in UTF-16LE = 2d 4e 87 65      (no zero bytes anywhere)
 *
 * So the decision is made by decoding the same bytes several ways and keeping the
 * interpretation with the fewest defects - replacement characters, unpaired surrogates,
 * noncharacters. That costs a few extra decodes on the first chunk and needs no
 * assumptions about the content.
 */

/** How many leading bytes to inspect when deciding an encoding. */
const SNIFF_BYTES = 512;

/**
 * Bytes to buffer before committing to an encoding.
 *
 * Deciding from the first few bytes is unreliable: three bytes of a UTF-16LE stream can
 * look like anything. Waiting for a small sample costs nothing for a job whose output
 * goes to a file, and it is what makes byte-by-byte delivery work.
 */
const DECIDE_AFTER_BYTES = 32;

/** Cost assigned to an interpretation that cannot be valid at all. */
const IMPOSSIBLE = 1e9;

export type DetectedEncoding = "utf16le" | "utf16be" | "utf8" | "gbk";

/** Count the characters a UTF-8 decode could not represent. */
/**
 * Count defects when reading the bytes as UTF-8.
 *
 * A trailing partial character is NOT counted. At a chunk boundary the last character
 * has simply not arrived yet; penalising it made UTF-8 lose to GBK on ASCII-heavy output.
 * Measured: a 64-byte slice of a UTF-8 markdown listing scored 1 for UTF-8 and 0 for GBK,
 * because the cut fell inside a Chinese character - the decode that was right looked worse
 * than the one that was wrong.
 */
function badnessUtf8(buf: Buffer): number {
	if (buf.length === 0) return 0;
	const usable = buf.length - incompleteUtf8TailLength(buf);
	const text = buf.subarray(0, usable).toString("utf8");
	let bad = 0;
	for (const ch of text) if (ch === "\uFFFD") bad++;
	return bad;
}

/**
 * Score both alignments and return the better one.
 *
 * Returning the offset, not just the score, is essential: detection may succeed on the
 * second alignment while decoding starts from the first, which produces text that is
 * correct for a few characters and then turns to noise. Measured on a synthesised
 * wsl.exe frame (odd binary header, then UTF-16LE text): detection picked the right
 * alignment and the output was still wrong.
 */
function scoreUtf16(buf: Buffer, endian: "le" | "be"): { bad: number; offset: number } {
	if (buf.length < 2) return { bad: IMPOSSIBLE, offset: 0 };
	let best = { bad: IMPOSSIBLE, offset: 0 };
	for (let offset = 0; offset <= 1 && offset < buf.length - 1; offset++) {
		const slice = buf.subarray(offset);
		const usable = slice.length - (slice.length % 2);
		if (usable < 2) continue;
		const score = badnessUtf16Aligned(slice.subarray(0, usable), endian);
		if (score < best.bad) best = { bad: score, offset };
	}
	return best;
}

/** Defects in an even-length buffer read as UTF-16, ignoring any misaligned tail. */
function badnessUtf16Aligned(buf: Buffer, endian: "le" | "be"): number {
	if (buf.length === 0) return 0;

	let bytes = buf;
	if (endian === "be") {
		bytes = Buffer.from(buf);
		bytes.swap16();
	}
	const text = bytes.toString("utf16le");

	let bad = 0;
	let printable = 0;
	let zeroHighBytes = 0;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		// In UTF-16LE the high byte of each unit is bytes[2i+1], which is 0 for every
		// ASCII character - and ASCII makes up most of the content of typical output.
		if (bytes[2 * i + 1] === 0x00) zeroHighBytes++;

		if (code === 0xfffd) {
			bad++;
			continue;
		}
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = text.charCodeAt(i + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				i++;
				printable++;
			} else bad++;
			continue;
		}
		if (code >= 0xdc00 && code <= 0xdfff) {
			bad++; // stray low surrogate
			continue;
		}
		if (code === 0xfffe || code === 0xffff) bad++;
		else printable++;
	}

	// A zero high byte is strong evidence that this is UTF-16: it is what ASCII looks like,
	// and ASCII dominates real output. But it is not a requirement - pure Chinese in
	// UTF-16LE has no zero byte at all ("中文" is 2d 4e 87 65), so demanding one rejected
	// the very case this decoder exists for. The requirement is only applied when NO zero
	// byte appears AND the bytes also read cleanly as UTF-8, which is what distinguishes
	// real UTF-16 from UTF-8 being misread: the latter always has a clean UTF-8 reading.
	if (zeroHighBytes === 0 && badnessUtf8(bytes) === 0) return IMPOSSIBLE;

	// Weight defects against the amount of genuine text. A wrong interpretation usually
	// produces few defects but almost no printable characters either, and it is that
	// combination - not the defect count alone - that identifies it. Measured: reading
	// `wsl.exe` output as GBK yielded only a handful of defects and was chosen over the
	// correct UTF-16 reading.
	return bad + Math.max(0, 4 - printable);
}

/** Count the characters a GBK decode could not represent. */
function badnessGbk(buf: Buffer): number {
	if (buf.length === 0) return 0;
	try {
		let bad = 0;
		for (const ch of new TextDecoder("gbk").decode(buf)) if (ch === "\uFFFD") bad++;
		return bad;
	} catch {
		return IMPOSSIBLE; // no GBK support in this runtime
	}
}

function decodeAs(buf: Buffer, encoding: DetectedEncoding, offset = 0): string {
	const body = offset > 0 ? buf.subarray(offset) : buf;
	switch (encoding) {
		case "utf16le":
			return body.toString("utf16le");
		case "utf16be": {
			const even = body.length - (body.length % 2);
			const swapped = Buffer.from(body.subarray(0, even));
			swapped.swap16();
			return swapped.toString("utf16le");
		}
		case "gbk":
			try {
				return new TextDecoder("gbk").decode(body);
			} catch {
				return body.toString("utf8");
			}
		default:
			return body.toString("utf8");
	}
}

function stripBom(text: string): string {
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** The best interpretation of these bytes, by defect count. */
export function detectEncoding(buf: Buffer): { encoding: DetectedEncoding; text: string } {
	if (buf.length === 0) return { encoding: "utf8", text: "" };

	// An explicit BOM settles it without any guessing.
	if (buf.length >= 2) {
		if (buf[0] === 0xff && buf[1] === 0xfe) {
			return { encoding: "utf16le", text: stripBom(buf.toString("utf16le", 2)) };
		}
		if (buf[0] === 0xfe && buf[1] === 0xff) {
			const swapped = Buffer.from(buf.subarray(2));
			if (swapped.length % 2 === 0) {
				swapped.swap16();
				return { encoding: "utf16be", text: stripBom(swapped.toString("utf16le")) };
			}
		}
	}

	// Pure ASCII is the same in every candidate worth trying.
	if (!buf.some((b) => b >= 0x80)) {
		return { encoding: "utf8", text: stripBom(buf.toString("utf8")) };
	}

	const le = scoreUtf16(buf, "le");
	const be = scoreUtf16(buf, "be");
	const candidates: Array<{ encoding: DetectedEncoding; bad: number; offset: number }> = [
		{ encoding: "utf8", bad: badnessUtf8(buf), offset: 0 },
		// UTF-8 (and GBK) tolerate a trailing partial character at a chunk boundary; a
		// single defect is therefore not enough to rule them out. UTF-16 is stricter.
		{ encoding: "utf16le", bad: le.bad, offset: le.offset },
		{ encoding: "utf16be", bad: be.bad, offset: be.offset },
		{ encoding: "gbk", bad: badnessGbk(buf), offset: 0 },
	];

	// Ties go to UTF-8: it is the overwhelmingly common case, and a clean UTF-8 decode
	// should never be displaced by an equally clean reading of the same bytes.
	//
	// Zero defects also settles it immediately, and that early exit matters: GBK accepts
	// almost any byte pair, so without it a defect-free UTF-8 decode keeps its 0 but GBK
	// also reports 0, and the runner-up position decides. Preferring a perfect UTF-8 read
	// outright is the honest rule - a clean decode is not evidence against itself.
	if (candidates[0].bad === 0) {
		return { encoding: "utf8", text: stripBom(decodeAs(buf, "utf8", 0)) };
	}

	let best = candidates[0];
	for (const candidate of candidates) {
		if (candidate.bad < best.bad) best = candidate;
	}

	return { encoding: best.encoding, text: stripBom(decodeAs(buf, best.encoding, best.offset)) };
}

/** Decode one self-contained chunk. Prefer {@link StreamDecoder} for streamed output. */
export function decodeOutputChunk(buf: Buffer): { text: string; encoding: DetectedEncoding } {
	return detectEncoding(buf);
}

/**
 * Incremental decoder that survives chunk boundaries and unknown encodings.
 *
 * Two problems have to be handled together:
 *
 *   1. The encoding is unknown until enough bytes have arrived. Decoding early produces
 *      replacement characters that cannot be repaired later, so output is held back
 *      until the sample is large enough - or until the stream ends.
 *   2. A multi-byte character can be split across two chunks. The trailing partial
 *      sequence is kept for the next push instead of being decoded in isolation.
 */
export class StreamDecoder {
	private encoding: DetectedEncoding | null = null;
	/** Alignment the encoding was decided at; the first buffer must be decoded from it. */
	private offset = 0;
	private firstBufferDecoded = false;
	private pending = Buffer.alloc(0);

	push(chunk: Buffer): string {
		if (chunk.length === 0) return "";
		this.pending = this.pending.length > 0 ? Buffer.concat([this.pending, chunk]) : chunk;

		if (this.encoding === null) {
			// Decide once the sample is big enough. Below that, hold everything back: the
			// caller sees no output for the first ~32 bytes, which is invisible in a job
			// log and far better than emitting mojibake.
			if (this.pending.length < DECIDE_AFTER_BYTES && !this.pending.some((b) => b === 0x00)) {
				return "";
			}
			const decision = detectEncoding(this.pending.subarray(0, SNIFF_BYTES));
			this.encoding = decision.encoding;
			// Learn the alignment from the same scoring that chose the encoding, so detection
			// and decoding agree. Decoding from a different alignment than the one scored
			// yields text that is correct for a few characters and then turns to noise.
			this.offset =
				this.encoding === "utf16le"
					? scoreUtf16(this.pending, "le").offset
					: this.encoding === "utf16be"
						? scoreUtf16(this.pending, "be").offset
						: 0;
		}

		const encoding = this.encoding;
		const held = this.incompleteTailLength(this.pending, encoding, this.firstBufferDecoded ? 0 : this.offset);
		if (held > 0) {
			const cut = this.pending.length - held;
			const ready = this.pending.subarray(0, cut);
			this.pending = Buffer.from(this.pending.subarray(cut));
			return this.emit(ready, encoding);
		}

		const out = this.emit(this.pending, encoding);
		this.pending = Buffer.alloc(0);
		return out;
	}

	/** Decode a buffer, applying the header offset only to the first one. */
	private emit(buf: Buffer, encoding: DetectedEncoding): string {
		const offset = this.firstBufferDecoded ? 0 : this.offset;
		this.firstBufferDecoded = true;
		return decodeAs(buf, encoding, offset);
	}

	/** Emit whatever is still buffered, deciding the encoding if that never happened. */
	flush(): string {
		if (this.pending.length === 0) return "";
		const decision = this.encoding ?? detectEncoding(this.pending).encoding;
		const out = this.emit(this.pending, decision);
		this.pending = Buffer.alloc(0);
		return out;
	}

	/** How many trailing bytes form an incomplete character in this encoding. */
	private incompleteTailLength(buf: Buffer, encoding: DetectedEncoding, offset: number): number {
		const body = offset > 0 ? buf.subarray(offset) : buf;
		if (encoding === "utf16le" || encoding === "utf16be") {
			return body.length % 2;
		}
		if (encoding !== "utf8") return 0; // GBK's partial pairs are not distinguishable here
		return incompleteUtf8TailLength(body);
	}
}

/**
 * How many trailing bytes form an incomplete UTF-8 sequence.
 *
 * A lead byte declares how long its sequence is, so a short tail can be identified
 * exactly: walk back over continuation bytes, look at the lead, and compare.
 */
function incompleteUtf8TailLength(buf: Buffer): number {
	const len = buf.length;
	if (len === 0) return 0;

	let walked = 0;
	while (walked < 4 && walked < len) {
		const byte = buf[len - 1 - walked];
		if ((byte & 0xc0) !== 0x80) break; // not a continuation byte
		walked++;
	}

	const leadIndex = len - 1 - walked;
	if (leadIndex < 0) return 0;
	const lead = buf[leadIndex];

	let expected = 0;
	if ((lead & 0x80) === 0x00) expected = 1; // ASCII, complete
	else if ((lead & 0xe0) === 0xc0) expected = 2;
	else if ((lead & 0xf0) === 0xe0) expected = 3;
	else if ((lead & 0xf8) === 0xf0) expected = 4;
	else return 0; // not a valid lead byte

	const available = walked + 1;
	return available < expected ? available : 0;
}

/** Decode a complete buffer through the incremental path, for consistency. */
export function decodeOutput(buf: Buffer): string {
	const decoder = new StreamDecoder();
	return decoder.push(buf) + decoder.flush();
}
