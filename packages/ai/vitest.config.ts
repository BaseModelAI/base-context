import { configDefaults, defineConfig } from "vitest/config";
import { credentialTests } from "../../scripts/test-suites.mjs";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000,
		exclude: [...configDefaults.exclude, ...(process.env.BASE_CONTEXT_CREDENTIAL_TESTS === "1" ? [] : credentialTests.ai)],
	},
});
