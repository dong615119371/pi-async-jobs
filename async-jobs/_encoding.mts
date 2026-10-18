/**
 * Tests for output decoding.
 *
 * Every case here is a real encoding a child process on this machine produces. The
 * UTF-16LE case is the one that was actually observed as mojibake in tool output and
 * misdiagnosed as a shell problem.
 */

import { spawnSync } from "node:child_process";
import { decodeOutput, decodeOutputChunk, detectEncoding, StreamDecoder } from "./encoding.ts";

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

/** Capture a command's combined output as raw bytes. */
function capture(cmd: string): Buffer {
	const r = spawnSync("bash", ["-c", cmd], { encoding: "buffer", windowsHide: true });
	return Buffer.concat([r.stdout ?? Buffer.alloc(0), r.stderr ?? Buffer.alloc(0)]);
}

console.log("output decoding\n");

// --------------------------------------------------------------- utf16le
console.log("E1: UTF-16LE is decoded correctly (the observed failure)");
{
	// Built by hand so the test does not depend on wsl.exe being present.
	const text = "未安装适用于 Linux 的 Windows 子系统";
	const buf = Buffer.from(text, "utf16le");
	const { text: decoded, encoding } = decodeOutputChunk(buf);
	check("encoding detected as utf16le", encoding === "utf16le", encoding);
	check("text round-trips", decoded === text, JSON.stringify(decoded));
	check("no replacement characters", !decoded.includes("\uFFFD"));
}

// ------------------------------------------------------------- real wsl.exe
console.log("\nE2: a real wsl.exe Chinese error decodes to readable text");
{
	const buf = capture("wsl.exe --status 2>&1 || true");
	if (buf.length === 0) {
		console.log("  SKIP  wsl.exe produced no output");
	} else {
		const text = decodeOutput(buf);
		const readable = text.includes("Windows") || text.includes("子系统");
		check("decodes to readable text", readable, JSON.stringify(text.slice(0, 70)));
		check("no replacement characters", !text.includes("\uFFFD"), JSON.stringify(text.slice(0, 70)));
	}
}

// ------------------------------------------------------------------ plain utf8
console.log("\nE3: ordinary UTF-8 passes through untouched");
{
	for (const s of ["plain ascii", "中文测试", "mixed 混合 text 123", "emoji 🎉"]) {
		const buf = Buffer.from(s, "utf8");
		const { text, encoding } = decodeOutputChunk(buf);
		check(`${JSON.stringify(s.slice(0, 12))} → utf8`, encoding === "utf8" && text === s, `${encoding} ${JSON.stringify(text)}`);
	}
}

// ---------------------------------------------------------------------- BOM
console.log("\nE4: byte-order marks are stripped");
{
	const withBomLe = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("hello", "utf16le")]);
	const r1 = decodeOutputChunk(withBomLe);
	check("UTF-16LE BOM stripped", r1.text === "hello", JSON.stringify(r1.text));
	check("BOM case detected as utf16le", r1.encoding === "utf16le", r1.encoding);

	const withBomUtf8 = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("hi", "utf8")]);
	const r2 = decodeOutputChunk(withBomUtf8);
	check("UTF-8 BOM stripped", r2.text === "hi", JSON.stringify(r2.text));
}

// --------------------------------------------------------- chunk boundaries
console.log("\nE5: characters split across chunks are not mangled");
{
	// Stream "中文测试" through the incremental decoder one byte at a time.
	const full = Buffer.from("中文测试", "utf8");
	const decoder = new StreamDecoder();
	let out = "";
	for (const byte of full) out += decoder.push(Buffer.from([byte]));
	out += decoder.flush();
	check("byte-by-byte UTF-8 reassembles", out === "中文测试", JSON.stringify(out));
	check("no replacement characters at seams", !out.includes("\uFFFD"));

	// Same for UTF-16LE, where a split can land in the middle of a code unit.
	const utf16 = Buffer.from("中文测试", "utf16le");
	const d2 = new StreamDecoder();
	let out2 = "";
	for (let i = 0; i < utf16.length; i += 3) out2 += d2.push(utf16.subarray(i, i + 3));
	out2 += d2.flush();
	check("odd-split UTF-16LE reassembles", out2 === "中文测试", JSON.stringify(out2));
}

// ----------------------------------------------------------- mixed line output
console.log("\nE6: multiple lines survive");
{
	const buf = Buffer.from("line one\nline two\n中文 third\n", "utf8");
	const { text } = decodeOutputChunk(buf);
	check("all lines present", text.split("\n").length >= 4, JSON.stringify(text));
	check("CJK preserved", text.includes("中文"), JSON.stringify(text));
}

// ------------------------------------------------------------------- empty
console.log("\nE7: edge inputs do not crash");
{
	check("empty buffer", decodeOutputChunk(Buffer.alloc(0)).text === "");
	check("single byte", typeof decodeOutputChunk(Buffer.from([0x41])).text === "string");
	check("single odd byte (utf16 candidate)", typeof decodeOutputChunk(Buffer.from([0x00])).text === "string");
	check("flush with nothing pending", new StreamDecoder().flush() === "");
}

// -------------------------------------------------------------- binary safety
console.log("\nE8: binary-ish bytes do not throw");
{
	const nasty = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x80, 0x90, 0xa0, 0xb0, 0xff]);
	let threw = false;
	try {
		decodeOutputChunk(nasty);
		decodeOutput(nasty);
	} catch {
		threw = true;
	}
	check("decoding random bytes does not throw", !threw);
}

// ------------------------------------------------------ E9 leading binary bytes
console.log("\nE9: binary header bytes do not defeat UTF-16 detection");
{
	// The real shape of `wsl.exe` output: a run of non-text header bytes, then UTF-16LE
	// text, and a total length that is not even. Scoring each alignment is what rescues
	// this; treating odd length as impossible sent it to GBK and produced mojibake.
	const header = Buffer.from([0x2a, 0x67, 0x89, 0x5b, 0xc5, 0x88, 0x02, 0x90, 0x28]);
	const text = "未安装适用于 Linux 的 Windows 子系统。";
	const payload = Buffer.concat([header, Buffer.from(text, "utf16le")]);
	check("total length is odd", payload.length % 2 === 1, String(payload.length));

	const { encoding, text: decoded } = decodeOutputChunk(payload);
	check("detected as utf16le despite the odd length", encoding === "utf16le", encoding);
	check("text recovered", decoded.includes("未安装适用于"), JSON.stringify(decoded.slice(0, 40)));
	check("no replacement characters", !decoded.includes("\uFFFD"), JSON.stringify(decoded.slice(0, 40)));
}

// ------------------------------------------------------- E10 real wsl re-check
console.log("\nE10: a genuine wsl.exe error decodes without mojibake");
{
	const buf = capture("wsl.exe --status 2>&1 | head -2");
	if (buf.length === 0) {
		console.log("  SKIP  no output");
	} else {
		const { encoding, text } = decodeOutputChunk(buf);
		check("no replacement characters", !text.includes("\uFFFD"), `${encoding} ${JSON.stringify(text.slice(0, 50))}`);
		check("contains readable Chinese or Latin text", /[\u4e00-\u9fff]|Linux|Windows/.test(text), JSON.stringify(text.slice(0, 50)));
	}
}

// ------------------------------------- E11 UTF-8 must not be misread as UTF-16
//
// The real defect: a UTF-8 listing of headings and Chinese was shown to the user as
//   㴽‽䭓䱉⹌
// because "== SK" pairs cleanly into UTF-16 code points 0x3D3D and 0x4B53, and on a large
// enough input the UTF-16 reading scored as well as the correct one.
console.log("\nE11: ASCII-heavy UTF-8 is never decoded as UTF-16");
{
	const text = "=== SKILL.md 结构 ===\n9:## 一、先认清当前是什么状态\n28:## 二、拿到作业号之后\n";
	const buf = Buffer.from(text, "utf8");

	// Every prefix length must agree: the decision is made on a sniff of the first bytes,
	// so a wrong verdict at one length is a wrong verdict in production.
	for (const n of [16, 32, 40, 64, 100]) {
		const got = detectEncoding(buf.subarray(0, n));
		check(
			`first ${n} bytes stay utf8`,
			got.encoding === "utf8",
			`${got.encoding} ${JSON.stringify(got.text.slice(0, 20))}`,
		);
	}

	// And through the streaming decoder, where a chunk cut can fall inside a character.
	for (const size of [8, 16, 32]) {
		const d = new StreamDecoder();
		let out = "";
		for (let i = 0; i < buf.length; i += size) out += d.push(buf.subarray(i, i + size));
		out += d.flush();
		check(`chunks of ${size} reassemble exactly`, out === text, JSON.stringify(out.slice(0, 30)));
	}
}

console.log(`\n${"=".repeat(52)}`);
console.log(`PASS ${pass}   FAIL ${fail}`);
// A failing suite must fail the process, or a CI gate reads a red run as green.
process.exitCode = fail > 0 ? 1 : 0;
