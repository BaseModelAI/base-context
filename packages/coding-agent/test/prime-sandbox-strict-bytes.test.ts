import { describe, expect, it } from "vitest";
import { copySandboxStrictBytes } from "../src/modes/daemon/sandbox/prime-sandbox-strict-bytes.js";

describe("sandbox strict byte copying", () => {
	it("copies a full fixed Uint8Array into caller-owned storage", () => {
		const source = new Uint8Array([1, 2, 255]);
		const result = copySandboxStrictBytes(source, 3);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(Array.from(result.value)).toEqual([1, 2, 255]);
		expect(result.value).not.toBe(source);
		expect(result.value.buffer).not.toBe(source.buffer);
		source[0] = 9;
		expect(result.value[0]).toBe(1);
		expect(Object.isFrozen(result)).toBe(true);
		expect(Object.isFrozen(result.value)).toBe(false);
	});

	it("accepts an empty fixed Uint8Array", () => {
		const result = copySandboxStrictBytes(new Uint8Array(0), 0);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value.byteLength).toBe(0);
	});

	it("rejects non-objects and invalid limits", () => {
		for (const value of [null, undefined, true, 1, "bytes", {}, []]) {
			expect(copySandboxStrictBytes(value, 16)).toEqual({ ok: false, code: "INPUT_INVALID" });
		}
		expect(copySandboxStrictBytes(new Uint8Array(0), -1)).toEqual({ ok: false, code: "INPUT_INVALID" });
		expect(copySandboxStrictBytes(new Uint8Array(0), 0.5)).toEqual({ ok: false, code: "INPUT_INVALID" });
		expect(copySandboxStrictBytes(new Uint8Array(0), 1_048_577)).toEqual({
			ok: false,
			code: "INPUT_INVALID",
		});
	});

	it("enforces the byte bound before copying", () => {
		expect(copySandboxStrictBytes(new Uint8Array(2), 1)).toEqual({ ok: false, code: "INPUT_TOO_LARGE" });
	});

	it("rejects sliced and nonzero-offset views", () => {
		const storage = new ArrayBuffer(8);
		expect(copySandboxStrictBytes(new Uint8Array(storage, 0, 4), 8)).toEqual({
			ok: false,
			code: "INPUT_INVALID",
		});
		expect(copySandboxStrictBytes(new Uint8Array(storage, 1, 7), 8)).toEqual({
			ok: false,
			code: "INPUT_INVALID",
		});
	});

	it("rejects shared and resizable backing storage", () => {
		const shared = new Uint8Array(new SharedArrayBuffer(4));
		expect(copySandboxStrictBytes(shared, 4)).toEqual({ ok: false, code: "INPUT_INVALID" });
		const resizable: unknown = Reflect.construct(ArrayBuffer, [4, { maxByteLength: 8 }]);
		const resizableView: unknown = Reflect.construct(Uint8Array, [resizable]);
		expect(copySandboxStrictBytes(resizableView, 8)).toEqual({ ok: false, code: "INPUT_INVALID" });
	});

	it("rejects detached storage including a zero-length view", () => {
		for (const length of [0, 4]) {
			const storage = new ArrayBuffer(length);
			const view = new Uint8Array(storage);
			structuredClone(storage, { transfer: [storage] });
			expect(copySandboxStrictBytes(view, 4)).toEqual({ ok: false, code: "INPUT_INVALID" });
		}
	});

	it("rejects proxy and revoked-proxy values before reflection", () => {
		let prototypeTrapCalls = 0;
		const proxy = new Proxy(new Uint8Array([1]), {
			getPrototypeOf(target): object | null {
				prototypeTrapCalls += 1;
				return Reflect.getPrototypeOf(target);
			},
		});
		expect(copySandboxStrictBytes(proxy, 1)).toEqual({ ok: false, code: "INPUT_INVALID" });
		expect(prototypeTrapCalls).toBe(0);
		const revoked = Proxy.revocable(new Uint8Array([1]), {});
		revoked.revoke();
		expect(copySandboxStrictBytes(revoked.proxy, 1)).toEqual({ ok: false, code: "INPUT_INVALID" });
	});

	it("rejects fake and alternate typed-array prototypes", () => {
		const fake = Object.create(Uint8Array.prototype);
		expect(copySandboxStrictBytes(fake, 4)).toEqual({ ok: false, code: "INPUT_INVALID" });
		expect(copySandboxStrictBytes(new Uint16Array([1]), 4)).toEqual({ ok: false, code: "INPUT_INVALID" });
	});

	it("rejects own fields and symbols on the view", () => {
		const named = new Uint8Array([1]);
		Object.defineProperty(named, "length", { value: 1, enumerable: false, configurable: true });
		expect(copySandboxStrictBytes(named, 1)).toEqual({ ok: false, code: "INPUT_INVALID" });
		const accessor = new Uint8Array([1]);
		Object.defineProperty(accessor, "extra", { get: () => 1, enumerable: true, configurable: true });
		expect(copySandboxStrictBytes(accessor, 1)).toEqual({ ok: false, code: "INPUT_INVALID" });
		const symbolic = new Uint8Array([1]);
		Object.defineProperty(symbolic, Symbol("extra"), { value: 1, enumerable: true, configurable: true });
		expect(copySandboxStrictBytes(symbolic, 1)).toEqual({ ok: false, code: "INPUT_INVALID" });
	});

	it("rejects shadow fields on the backing ArrayBuffer", () => {
		for (const name of ["byteLength", "detached", "resizable", "extra"]) {
			const storage = new ArrayBuffer(1);
			const view = new Uint8Array(storage);
			Object.defineProperty(storage, name, { value: 1, enumerable: true, configurable: true });
			expect(copySandboxStrictBytes(view, 1)).toEqual({ ok: false, code: "INPUT_INVALID" });
		}
		const symbolStorage = new ArrayBuffer(1);
		const symbolView = new Uint8Array(symbolStorage);
		Object.defineProperty(symbolStorage, Symbol("extra"), { value: 1, configurable: true });
		expect(copySandboxStrictBytes(symbolView, 1)).toEqual({ ok: false, code: "INPUT_INVALID" });
	});

	it("requires Bun's exact typed-array index descriptor flags", () => {
		const view = new Uint8Array([1]);
		const descriptor = Object.getOwnPropertyDescriptor(view, "0");
		expect(descriptor).toEqual({ value: 1, writable: true, enumerable: true, configurable: true });
		const fake = Object.create(Uint8Array.prototype);
		Object.defineProperty(fake, "0", { value: 1, writable: true, enumerable: true, configurable: false });
		expect(copySandboxStrictBytes(fake, 1)).toEqual({ ok: false, code: "INPUT_INVALID" });
	});
});
