#!/usr/bin/env node
import { resolve } from "node:path";
import { getPhysicalPackageDir } from "./config.js";
import { prepareOwnedKernelPython } from "./core/kernel/bootstrap.js";
import {
	captureOwnedUpdate,
	installOwnedRelease,
	type OwnedActivation,
	OwnedInstallActivatedError,
	rollbackOwnedRelease,
} from "./owned-install.js";
import {
	defaultInstallRoot,
	getOwnedInstallation,
	parseInstallSelection,
	readInstallSelection,
} from "./owned-install-layout.js";
import { PRODUCT_ENV } from "./product-identity.js";

let activation: OwnedActivation | undefined;

async function main(): Promise<void> {
	const [command, ...args] = process.argv.slice(2);
	if (command === "prepare") {
		// A dedicated, provider-free candidate entry. Manual overrides remain ordinary-route only.
		delete process.env[PRODUCT_ENV.kernelPython];
		delete process.env[PRODUCT_ENV.kernelVenv];
		delete process.env[PRODUCT_ENV.packageDirectory];
		delete process.env.PYTHONHOME;
		delete process.env.PYTHONPATH;
		await prepareOwnedKernelPython();
		return;
	}
	const ownInstallation = getOwnedInstallation(getPhysicalPackageDir());
	const root = resolve(args[0] ?? ownInstallation?.root ?? defaultInstallRoot());
	const expected =
		args[1] !== undefined
			? parseInstallSelection(args[1])
			: ownInstallation?.root === root
				? captureOwnedUpdate(ownInstallation)
				: readInstallSelection(root);
	if (command === "install" && args[2] && args[3]) {
		const result = await installOwnedRelease({ root, expected, installSpec: args[2], version: args[3] });
		activation = result;
		console.log(`Base-Context activated: ${result.installation.packageDir}`);
	} else if (command === "rollback" && expected) {
		const result = rollbackOwnedRelease(root, expected);
		activation = result;
		console.log(
			`Base-Context rollback selected: ${result.installation.packageDir}. Running owners retain their files.`,
		);
	} else {
		throw new Error(
			"Usage: base-context-install install <root> <original-selection-json> <package> <version> | rollback [root]",
		);
	}
}

// The separate bundled entry deliberately does not import the agent/model/auth startup.
void main().catch((error: unknown) => {
	const accepted = error instanceof OwnedInstallActivatedError ? error.activation : activation;
	if (accepted)
		console.error(
			`Base-Context activation was accepted for ${accepted.installation.packageDir}; no rollback was attempted.`,
		);
	console.error(error);
	process.exitCode = 1;
});
