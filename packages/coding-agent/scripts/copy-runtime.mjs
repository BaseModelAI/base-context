import { cpSync, rmSync } from "node:fs";
import { basename } from "node:path";

const source = new URL("../../../prime-agent-runtime", import.meta.url);
const destination = new URL("../dist/base-context-runtime", import.meta.url);

rmSync(destination, { recursive: true, force: true });
cpSync(source, destination, {
	recursive: true,
	filter: (path) => basename(path) !== "__pycache__" && !/\.py[co]$/.test(path),
});
