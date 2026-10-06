/** Explicit Bash registration for subprocess profiles that request `tools: bash`. */
import { createBashToolDefinition, type ExtensionAPI } from "@ponythewhite/base-context";

export default function bashToolExtension(pi: ExtensionAPI): void {
	pi.registerTool(createBashToolDefinition(process.cwd()));
}
