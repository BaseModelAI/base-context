import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, unlinkSync, writeSync } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";

export const RETAINED_OUTPUT_FIELD = "/message/content/0/text";
export const TOOL_OUTPUT_PREVIEW_BYTES = 8 * 1024;
export const ROUTINE_TOOL_OUTPUT_PREVIEW_BYTES = 4 * 1024;

export function getToolOutputPreviewBytes(result: { status: string; stderr: string; error?: unknown }): number {
	return result.status === "ok" && !result.stderr && !result.error
		? ROUTINE_TOOL_OUTPUT_PREVIEW_BYTES
		: TOOL_OUTPUT_PREVIEW_BYTES;
}
export const PUBLIC_TEXT_WINDOW_BYTES = 64 * 1024;

export interface RetainedToolOutput {
	artifactId: string;
	field: typeof RETAINED_OUTPUT_FIELD;
	byteLength: number;
	/** False when upstream already discarded output, or capture completeness was not reported. */
	captureComplete: boolean;
	/** Capture failed after admission; the artifact contains only the bytes actually written. */
	captureError?: "write_failed" | "close_failed";
}

export function retainedToolOutput(value: unknown): RetainedToolOutput | undefined {
	if (!value || typeof value !== "object") return undefined;
	const item = value as RetainedToolOutput;
	return typeof item.artifactId === "string" &&
		/^[0-9a-f-]{36}\.log$/.test(item.artifactId) &&
		item.field === RETAINED_OUTPUT_FIELD &&
		Number.isSafeInteger(item.byteLength) &&
		item.byteLength >= 0 &&
		typeof item.captureComplete === "boolean"
		? item
		: undefined;
}

/** Plain UTF-8 logs in the existing session artifact directory, published only after close. */
export async function retainToolOutput(
	directory: string,
	parts: readonly string[],
	captureComplete: boolean,
): Promise<RetainedToolOutput> {
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const descriptor: RetainedToolOutput = {
		artifactId: `${randomUUID()}.log`,
		field: RETAINED_OUTPUT_FIELD,
		byteLength: 0,
		captureComplete,
	};
	const file = await open(join(directory, descriptor.artifactId), "wx", 0o600);
	try {
		for (const part of parts) {
			const bytes = Buffer.from(part);
			let offset = 0;
			while (offset < bytes.length) offset += (await file.write(bytes, offset)).bytesWritten;
			descriptor.byteLength += bytes.length;
		}
	} finally {
		await file.close();
	}
	return descriptor;
}

/** Incremental capture in the existing artifact format; synchronous writes provide backpressure. */
export class ToolOutputCapture {
	private fd: number | undefined;
	private channel?: string;
	private readonly descriptor: RetainedToolOutput;
	private readonly path: string;

	constructor(directory: string) {
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		this.descriptor = {
			artifactId: `${randomUUID()}.log`,
			field: RETAINED_OUTPUT_FIELD,
			byteLength: 0,
			captureComplete: false,
		};
		this.path = join(directory, this.descriptor.artifactId);
		this.fd = openSync(this.path, "wx", 0o600);
	}

	append(channel: "stdout" | "stderr" | "result" | "error" | "background (unattributed)", text: string): void {
		if (this.fd === undefined || this.descriptor.captureError || !text) return;
		try {
			if (this.channel !== channel) {
				this.write(`${this.descriptor.byteLength ? "\n" : ""}[${channel}]\n`);
				this.channel = channel;
			}
			this.write(text);
		} catch {
			this.descriptor.captureError = "write_failed";
		}
	}

	private write(text: string): void {
		// Bound temporary UTF-8 buffers even for a large single protocol event.
		for (let start = 0; start < text.length; ) {
			let end = Math.min(start + 16 * 1024, text.length);
			if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
			const bytes = Buffer.from(text.slice(start, end));
			let offset = 0;
			while (offset < bytes.length) {
				const written = writeSync(this.fd!, bytes, offset);
				if (written === 0) throw new Error("Retained output write made no progress");
				offset += written;
				this.descriptor.byteLength += written;
			}
			start = end;
		}
	}

	finish(captureComplete: boolean, previewBytes = TOOL_OUTPUT_PREVIEW_BYTES): RetainedToolOutput | undefined {
		if (this.fd === undefined) return undefined;
		try {
			closeSync(this.fd);
		} catch {
			this.descriptor.captureError ??= "close_failed";
		} finally {
			this.fd = undefined;
		}
		this.descriptor.captureComplete = captureComplete && !this.descriptor.captureError;
		if (this.descriptor.captureComplete && this.descriptor.byteLength <= previewBytes - 2048) {
			try {
				unlinkSync(this.path);
			} catch {
				/* An unused small artifact must not block result delivery. */
			}
			return undefined;
		}
		return { ...this.descriptor };
	}
}

export function decodedTextWindow(text: string, startByte = 0, endByte = Buffer.byteLength(text)) {
	const bytes = Buffer.from(text);
	let start = Math.min(startByte, bytes.length);
	let end = Math.min(endByte, bytes.length);
	while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
	while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
	end = Math.max(start, end);
	return { text: bytes.subarray(start, end).toString("utf8"), startByte: start, endByte: end };
}

/** A bounded decoded-text byte window; no JSON event or complete artifact is materialized. */
export async function readRetainedToolOutput(
	directory: string,
	descriptor: RetainedToolOutput,
	startByte: number,
	maxBytes: number,
) {
	const file = await open(join(directory, descriptor.artifactId), "r");
	try {
		const stat = await file.stat();
		if (stat.size !== descriptor.byteLength) throw new Error("Retained output is unavailable");
		const start = Math.min(startByte, stat.size);
		const bytes = Buffer.alloc(Math.min(maxBytes + 4, stat.size - start));
		let length = 0;
		while (length < bytes.length) {
			const read = await file.read(bytes, length, bytes.length - length, start + length);
			if (read.bytesRead === 0) throw new Error("Retained output is unavailable");
			length += read.bytesRead;
		}
		let begin = 0;
		while (begin < length && (bytes[begin] & 0xc0) === 0x80) begin++;
		let end = Math.min(maxBytes, length);
		while (end > begin && end < length && (bytes[end] & 0xc0) === 0x80) end--;
		end = Math.max(begin, end);
		return {
			text: bytes.subarray(begin, end).toString("utf8"),
			startByte: start + begin,
			endByte: start + end,
			sourceBytes: length,
		};
	} finally {
		await file.close();
	}
}

/** Bound before encoding, so preview generation never copies a giant string to a second buffer. */
export function outputExcerpt(text: string | undefined, maxBytes: number): string | undefined {
	if (text === undefined) return undefined;
	if (Buffer.byteLength(text) <= maxBytes) return text;
	const marker = "\n[... omitted; read retained output ...]\n";
	const allowance = Math.max(0, Math.floor((maxBytes - Buffer.byteLength(marker)) / 2));
	const head = decodedTextWindow(text.slice(0, allowance + 2), 0, allowance).text;
	const tail = text.slice(-allowance - 2);
	const tailBytes = Buffer.byteLength(tail);
	return head + marker + decodedTextWindow(tail, Math.max(0, tailBytes - allowance), tailBytes).text;
}
