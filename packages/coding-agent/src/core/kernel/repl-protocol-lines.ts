// The runtime emits ensure_ascii JSON: each encoded character is one UTF-16 code unit.
export const MAX_REPL_PROTOCOL_LINE_CHARS = 32 * 1024 * 1024;

export class ReplProtocolLineTooLongError extends Error {}

export class ReplProtocolLineParser {
	private segments: string[] = [];
	private length = 0;

	constructor(private readonly maxChars = MAX_REPL_PROTOCOL_LINE_CHARS) {}

	push(text: string, onLine: (line: string) => boolean): void {
		let start = 0;
		while (start < text.length) {
			const newline = text.indexOf("\n", start);
			const end = newline === -1 ? text.length : newline;
			this.length += end - start;
			if (this.length > this.maxChars) {
				this.segments = [];
				throw new ReplProtocolLineTooLongError(`protocol line exceeds ${this.maxChars} encoded characters`);
			}
			if (end > start) this.segments.push(text.slice(start, end));
			if (newline === -1) return;
			const line = this.segments.length === 1 ? this.segments[0]! : this.segments.join("");
			this.segments = [];
			this.length = 0;
			if (!onLine(line)) return;
			start = newline + 1;
		}
	}
}
