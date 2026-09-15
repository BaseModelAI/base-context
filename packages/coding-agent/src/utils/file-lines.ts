import { closeSync, createReadStream, openSync, readSync } from "node:fs";

export function readFirstLineBufferSync(
	filePath: string,
	maxBytes = 64 * 1024,
	allowIncomplete = false,
): Buffer | undefined {
	const fd = openSync(filePath, "r");
	const chunks: Buffer[] = [];
	let position = 0;
	try {
		const buffer = Buffer.alloc(1024);
		while (position < maxBytes) {
			const count = readSync(fd, buffer, 0, Math.min(buffer.length, maxBytes - position), position);
			if (count === 0) break;
			const chunk = buffer.subarray(0, count);
			const newline = chunk.indexOf(0x0a);
			if (newline !== -1) {
				chunks.push(Buffer.from(chunk.subarray(0, newline + 1)));
				return Buffer.concat(chunks);
			}
			chunks.push(Buffer.from(chunk));
			position += count;
		}
	} finally {
		closeSync(fd);
	}
	return allowIncomplete && chunks.length > 0 ? Buffer.concat(chunks) : undefined;
}

export function readFirstLineSync(filePath: string, maxBytes = 64 * 1024, completeOnly = false): string | undefined {
	return readFirstLineBufferSync(filePath, maxBytes, !completeOnly)
		?.toString("utf8")
		.replace(/\n$/, "")
		.replace(/\r$/, "");
}

export async function* readLinesAsBuffers(
	filePath: string,
	options: { maxLineBytes?: number; includeNewline?: boolean; completeOnly?: boolean } = {},
): AsyncGenerator<Buffer> {
	const maxBytes = options.maxLineBytes ?? Infinity;
	if (maxBytes <= 0 || (maxBytes !== Infinity && !Number.isSafeInteger(maxBytes)))
		throw new Error("Invalid line byte limit");
	const pendingParts: Buffer[] = [];
	let pendingBytes = 0;
	for await (const chunk of createReadStream(filePath)) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		let start = 0;
		while (start < buffer.length) {
			const end = buffer.indexOf(0x0a, start);
			const stop = end === -1 ? buffer.length : end + (options.includeNewline ? 1 : 0);
			const part = buffer.subarray(start, stop);
			if (pendingBytes + part.length > maxBytes) throw new Error("Line byte limit exceeded");
			if (end === -1) {
				pendingParts.push(part);
				pendingBytes += part.length;
				break;
			}
			if (pendingParts.length > 0) {
				pendingParts.push(part);
				const line = Buffer.concat(pendingParts, pendingBytes + part.length);
				pendingParts.length = 0;
				pendingBytes = 0;
				yield line;
			} else yield part;
			start = end + 1;
		}
	}
	if (pendingParts.length > 0 && !options.completeOnly) yield Buffer.concat(pendingParts, pendingBytes);
}
