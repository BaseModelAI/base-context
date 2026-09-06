import { afterEach, describe, expect, it, vi } from "vitest";
import { PRODUCT } from "../src/product-identity.js";
import {
	checkForNewPiVersion,
	comparePackageVersions,
	getLatestPiRelease,
	getLatestPiVersion,
	isNewerPackageVersion,
} from "../src/utils/version-check.js";

const registryPackageUrl = `https://registry.npmjs.org/${encodeURIComponent(PRODUCT.packageName)}`;
const privateDownloadBaseUrl = "https://downloads.example.com/base-context";
const originalSkipVersionCheck = process.env.BASE_CONTEXT_SKIP_VERSION_CHECK;
const originalOffline = process.env.BASE_CONTEXT_OFFLINE;
const originalPrimeAgentDownloadBaseUrl = process.env.BASE_CONTEXT_DOWNLOAD_BASE_URL;

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[name];
		return;
	}
	process.env[name] = value;
}

afterEach(() => {
	vi.unstubAllGlobals();
	restoreEnv("BASE_CONTEXT_SKIP_VERSION_CHECK", originalSkipVersionCheck);
	restoreEnv("BASE_CONTEXT_OFFLINE", originalOffline);
	restoreEnv("BASE_CONTEXT_DOWNLOAD_BASE_URL", originalPrimeAgentDownloadBaseUrl);
});

describe("version checks", () => {
	it("compares package versions", () => {
		expect(comparePackageVersions("0.70.6", "0.70.5")).toBeGreaterThan(0);
		expect(comparePackageVersions("0.70.5", "0.70.5")).toBe(0);
		expect(comparePackageVersions("0.70.4", "0.70.5")).toBeLessThan(0);
		expect(comparePackageVersions("0.70.5-beta.10.1.abcdef0", "0.70.5-beta.9.1.1234567")).toBeGreaterThan(0);
		expect(isNewerPackageVersion("0.70.5", "0.70.5")).toBe(false);
		expect(isNewerPackageVersion("0.70.6", "0.70.5")).toBe(true);
	});

	it("returns only newer versions", async () => {
		const fetchMock = vi.fn(async () => Response.json({ version: "v1.2.3" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(checkForNewPiVersion("1.2.3")).resolves.toBeUndefined();
		await expect(checkForNewPiVersion("1.2.2")).resolves.toBe("1.2.3");
	});

	it("uses the owned npm package with a Base Context user agent", async () => {
		const fetchMock = vi.fn(async () => Response.json({ version: "v1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiVersion("1.2.3")).resolves.toBe("1.2.4");
		expect(fetchMock).toHaveBeenCalledWith(
			`${registryPackageUrl}/latest`,
			expect.objectContaining({
				headers: expect.objectContaining({
					"User-Agent": expect.stringMatching(/^base-context\/1\.2\.3 /),
					accept: "application/json",
				}),
			}),
		);
	});

	it("keeps beta installations on the beta release manifest", async () => {
		const fetchMock = vi.fn(async () => Response.json({ version: "v1.2.4-beta.124.1.abcdef0" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiVersion("1.2.4-beta.123.1.1234567")).resolves.toBe("1.2.4-beta.124.1.abcdef0");
		expect(fetchMock).toHaveBeenCalledWith(`${registryPackageUrl}/beta`, expect.any(Object));
	});

	it("returns the active package and tarball install spec from an explicit release manifest", async () => {
		process.env.BASE_CONTEXT_DOWNLOAD_BASE_URL = privateDownloadBaseUrl;
		const fetchMock = vi.fn(async () =>
			Response.json({
				package: PRODUCT.packageName,
				tarball: "releases/v1.2.4/base-context-1.2.4.tgz",
				version: "v1.2.4",
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiRelease("1.2.3")).resolves.toEqual({
			installSpec: `${privateDownloadBaseUrl}/releases/v1.2.4/base-context-1.2.4.tgz`,
			packageName: PRODUCT.packageName,
			version: "1.2.4",
		});
	});

	it("ignores a release manifest for another product", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ package: "prime-agent", version: "9.9.9" })),
		);
		await expect(getLatestPiRelease("0.1.0")).resolves.toBeUndefined();
	});

	it("skips api calls when version checks are disabled", async () => {
		process.env.BASE_CONTEXT_SKIP_VERSION_CHECK = "1";
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiVersion("1.2.3")).resolves.toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
