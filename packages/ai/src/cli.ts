#!/usr/bin/env node

import { getOAuthProviders } from "./utils/oauth/index.js";

const guidance =
	"OAuth is unavailable: these client identities are not validated for Base Context. Use the base-context CLI with a supported provider API key.";
const [command] = process.argv.slice(2);

if (command === "login") {
	console.error(guidance);
	process.exitCode = 1;
} else if (command === "list") {
	for (const provider of getOAuthProviders()) {
		console.log(`${provider.id}: unavailable (OAuth contract unvalidated)`);
	}
} else if (!command || ["help", "--help", "-h"].includes(command)) {
	console.log(`Usage: base-context-ai list

List the inherited OAuth adapters and their availability.
${guidance}`);
} else {
	console.error(`Unknown command: ${command}. Use base-context-ai --help.`);
	process.exitCode = 1;
}
