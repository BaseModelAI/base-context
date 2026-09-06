/** Encode plain JSON data without first allocating an unbounded serialized record. */
export function stringifyBoundedJson(value: unknown, maxBytes: number): string {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("Invalid JSON byte limit");
	let remaining = maxBytes;
	const chunks: string[] = [];
	function append(chunk: string): void {
		remaining -= Buffer.byteLength(chunk);
		if (remaining < 0) throw new Error("JSON byte limit exceeded");
		chunks.push(chunk);
	}
	function text(value: string): void {
		// Escaping one primitive can use at most six times the remaining byte budget.
		if (value.length > remaining) throw new Error("JSON byte limit exceeded");
		append(JSON.stringify(value));
	}
	function encode(item: unknown, depth: number): void {
		if (depth > 64) throw new Error("JSON nesting limit exceeded");
		if (item === null || typeof item === "boolean" || typeof item === "number") {
			append(JSON.stringify(item));
		} else if (typeof item === "string") {
			text(item);
		} else if (Array.isArray(item)) {
			append("[");
			let first = true;
			for (const value of item) {
				if (!first) append(",");
				first = false;
				encode(value === undefined ? null : value, depth + 1);
			}
			append("]");
		} else if (typeof item === "object") {
			const prototype: unknown = Object.getPrototypeOf(item);
			if (prototype !== null && prototype !== Object.prototype) throw new Error("Expected plain JSON data");
			append("{");
			let first = true;
			for (const key in item) {
				const field = Object.getOwnPropertyDescriptor(item, key);
				if (!field?.enumerable) continue;
				if (!("value" in field)) throw new Error("JSON accessors are not supported");
				if (field.value === undefined) continue;
				if (!first) append(",");
				first = false;
				text(key);
				append(":");
				encode(field.value, depth + 1);
			}
			append("}");
		} else {
			throw new Error("Expected JSON data");
		}
	}
	encode(value, 0);
	return chunks.join("");
}
