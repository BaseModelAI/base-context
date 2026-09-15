#!/usr/bin/env python3
"""Reproduce only the private, selected stock SDK cost-accounting patch. No installs."""
from pathlib import Path
import argparse
import json
import os
import shutil

HERE = Path(__file__).resolve().parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--source-host", type=Path, required=True, help="Pristine prepared prime-agent 0.9.4 host directory")
parser.add_argument("--output", type=Path, required=True, help="New private host directory; must not exist")
args = parser.parse_args()
SOURCE = args.source_host.resolve(strict=True)
TARGET = args.output.resolve()
PATCH_VERSION = "prime-agent-0.9.4-cost-accounting-1"
if TARGET.exists():
    raise SystemExit(f"Refusing to overwrite existing private host: {TARGET}")
TARGET.mkdir()
shutil.copytree(SOURCE / "unpacked", TARGET / "unpacked", symlinks=True)

def mapping(source, target):
    if source.is_symlink():
        resolved = source.resolve()
        if resolved.is_relative_to(SOURCE):
            resolved = TARGET / resolved.relative_to(SOURCE)
        target.symlink_to(resolved, target_is_directory=source.is_dir())
    elif source.is_dir():
        target.mkdir()
        for item in source.iterdir():
            mapping(item, target / item.name)
    else:
        shutil.copy2(source, target)

mapping(SOURCE / "node_modules", TARGET / "node_modules")
openai_source = (SOURCE / "node_modules/openai").resolve()
(TARGET / "node_modules/openai").unlink()
shutil.copytree(openai_source, TARGET / "node_modules/openai", symlinks=True)
shutil.copy2(HERE / "cost-accounting.mjs", TARGET / "cost-accounting.mjs")
changes = []

def replace(text, old, new, count=1):
    actual = text.count(old)
    if actual != count:
        raise ValueError(f"Expected {count} exact occurrences, got {actual}: {old[:100]}")
    return text.replace(old, new)

def patch(relative, transform):
    path = TARGET / relative
    text = path.read_text()
    text = transform(text)
    module = os.path.relpath(TARGET / "cost-accounting.mjs", path.parent)
    text = f'import {{ accounting as __cost }} from {json.dumps(module)};\n' + text
    path.write_text(text)
    changes.append(relative)

AGENT = "unpacked/prime-agent/package/dist/"
AI = "unpacked/prime-agent-ai/package/dist/"

def adapter(text, name):
    start = text.index(f"export const {name} =")
    end = text.index("export const streamSimple", start)
    region = text[start:end]
    region = replace(region, "(async () => {", "__cost.operation(model, options, async () => {")
    region = replace(region, "})();", "});")
    region = replace(region, "stream.end();", "__cost.finish(output);\n            stream.end();", region.count("stream.end();"))
    region = replace(region, "recordStreamFailure(model, output, error);", "__cost.error(error);\n            recordStreamFailure(model, output, error);")
    return text[:start] + region + text[end:]

def codex(text):
    text = adapter(text, "streamOpenAICodexResponses")
    text = replace(text, "const bodyJson = JSON.stringify(body);", "__cost.configure(body);\n            const bodyJson = JSON.stringify(body);")
    text = replace(text, "response = await fetch(resolveCodexUrl(model.baseUrl), {", "response = await __cost.fetch(fetch, resolveCodexUrl(model.baseUrl), {")
    text = replace(text, "const parsed = JSON.parse(raw);", "const parsed = JSON.parse(raw);\n        __cost.parsedError(parsed);")
    text = replace(text, "await connectWebSocket(url, headers, signal)", "await __cost.connect(connectWebSocket, url, headers, signal)", 3)
    text = replace(text, 'socket.send(JSON.stringify({ type: "response.create", ...requestBody }));', '__cost.begin("websocket", url);\n        socket.send(JSON.stringify({ type: "response.create", ...requestBody }));')
    text = replace(text, "for await (const event of events) {\n        const type =", "for await (const event of events) {\n        __cost.event(event);\n        const type =")
    text = replace(text, "catch (error) {\n        if (entry) {", 'catch (error) {\n        __cost.settle(options?.signal?.aborted ? "cancelled" : "failed", error);\n        if (entry) {')
    return text

patch(AI + "providers/openai-codex-responses.js", codex)

def completions(text):
    text = adapter(text, "streamOpenAICompletions")
    text = replace(text, "const { data: openaiStream, response } = await client.chat.completions", "__cost.configure(params);\n            const { data: openaiStream, response } = await client.chat.completions")
    text = replace(text, "for await (const chunk of openaiStream) {", "for await (const chunk of openaiStream) {\n                __cost.chunk(chunk);")
    return text

patch(AI + "providers/openai-completions.js", completions)
def openai_client(text):
    text = replace(text, "return await this.fetch.call(undefined, url, fetchOptions);",
        "return await __cost.fetch(this.fetch, url, fetchOptions);")
    return replace(text, "const errJSON = safeJSON(errText);",
        "const errJSON = safeJSON(errText);\n            __cost.parsedError(errJSON ?? errText);")
patch("node_modules/openai/client.mjs", openai_client)
def openai_streaming(text):
    text = replace(text, "if (data && data.error) {", 'if (data && data.error) {\n                            __cost.parsedError(data, "stream_error");')
    return replace(text, "if (sse.event == 'error') {", 'if (sse.event == \'error\') {\n                            __cost.parsedError(data, "stream_error");')
patch("node_modules/openai/core/streaming.mjs", openai_streaming)
patch(AGENT + "core/sdk.js", lambda text: replace(text,
    "return streamSimple(model, context, {", 'return __cost.call("main", streamSimple, model, context, {'))

def purposes(text, names):
    old = "completeWithProviderRetry(() => completeSimple(model,"
    if text.count(old) != len(names):
        raise ValueError("Auxiliary call count mismatch")
    for name in names:
        text = text.replace(old, f'__cost.call("{name}", completeWithProviderRetry, () => completeSimple(model,', 1)
    return text

patch(AGENT + "core/compaction/compaction.js", lambda text: purposes(text, ["compaction:history", "compaction:turn-prefix"]))
patch(AGENT + "core/compaction/branch-summarization.js", lambda text: purposes(text, ["branch-summary"]))
patch(AGENT + "core/refinement/refinement.js", lambda text: purposes(text, ["refinement", "auto-refine-review"]))
patch(AGENT + "modes/daemon/daemon-session-summarizer.js", lambda text: purposes(text, ["daemon-status"]))
metadata = {
    "patch_version": PATCH_VERSION,
    "source_host_root": str(SOURCE), "private_host_root": str(TARGET),
    "package_root": str(TARGET / "unpacked/prime-agent/package"),
    "package_name": "prime-agent", "version": "0.9.4",
    "compiled_coding_package_name": "@earendil-works/pi-coding-agent",
    "selected_entrypoint": str(TARGET / "unpacked/prime-agent/package/dist/index.js"),
    "bundle_entrypoint": str(TARGET / "unpacked/prime-agent/package/dist/bundle/cli.js"),
    "bundle_accounting_qualified": False,
    "dependency_root": json.loads((SOURCE / "hosts.json").read_text())["dependency_root"],
    "private_openai_version": json.loads((TARGET / "node_modules/openai/package.json").read_text())["version"],
    "changed_files": changes + ["cost-accounting.mjs"],
    "selected_apis": ["openai-codex-responses", "openai-completions"],
    "sidecar_env": "PRIME_COST_ACCOUNTING_PATH", "schema": "prime-cost-accounting/1",
    "reproduce": "Run apply_patch.py --source-host PRISTINE_HOST_DIRECTORY --output NEW_PRIVATE_DIRECTORY in the offline envelope.",
    "behavioral_changes": [], "provider_admission": False,
}
(TARGET / "accounting-patch.json").write_text(json.dumps(metadata, indent=2) + "\n")
print(json.dumps({"private_host": str(TARGET), "patch_version": PATCH_VERSION, "patched_file_count": len(changes)}, indent=2))
