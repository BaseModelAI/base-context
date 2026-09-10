import { stripFrontmatter } from "../utils/frontmatter.js";
import {
	CONTEXT_EPOCH_DETAIL,
	type ContextEpochCheckpoint,
	type EpochViewReference,
	readContextEpoch,
} from "./context-epoch.js";
import type { ContextManifestCursor, ContextRef, IndexedSourceEvent } from "./history-index.js";
import { hydrateCapturedHistoryEntry, type SessionHistoryReadView } from "./session-history-index.js";
import type { SessionEntry } from "./session-manager.js";
import { readSkillFile, type Skill, type SkillPythonMetadata } from "./skills.js";

export const SELECTED_SKILL_CUSTOM_TYPE = "base-context-selected-skill";
export const SELECTED_SKILL_DETAIL = "baseContextSelectedSkill";

export interface SelectedSkillDescriptor {
	name: string;
	description: string;
	kind: "markdown" | "python";
	filePath: string;
	baseDir: string;
	disableModelInvocation: boolean;
	sourceInfo?: Skill["sourceInfo"];
	python?: SkillPythonMetadata;
}

/** One actual selection capture; the canonical source owns the body after append. */
export interface SelectedSkillCapture {
	descriptor: SelectedSkillDescriptor;
	content: string;
}

export interface SelectedSkillReference {
	readonly name: string;
	readonly view: Omit<EpochViewReference, "ref"> & {
		readonly ref: Omit<EpochViewReference["ref"], "kind"> & { readonly kind: "custom_message" | "custom" };
	};
}

export interface NativeSkillSourceRef {
	readonly sessionId: string;
	readonly sessionFile: string | undefined;
	readonly entryId: string;
}

export interface CapturedSkillSelectionWriter {
	assertCurrent(): void;
	append(capture: SelectedSkillCapture, producer: "model" | "command"): Promise<string>;
}

export function captureSkillDescriptor(skill: Skill): SelectedSkillDescriptor {
	return {
		name: skill.name,
		description: skill.description,
		kind: skill.kind,
		filePath: skill.filePath,
		baseDir: skill.baseDir,
		disableModelInvocation: skill.disableModelInvocation,
		sourceInfo: structuredClone(skill.sourceInfo),
		...(skill.kind === "python" ? { python: { ...skill.python } } : {}),
	};
}

export function captureSelectedSkill(descriptor: SelectedSkillDescriptor): SelectedSkillCapture {
	return { descriptor, content: readSkillFile(descriptor.filePath) };
}

/** Visibility policy is current; the effective source identity must not be substituted. */
export function selectedSkillIdentity(descriptor: SelectedSkillDescriptor): string {
	return JSON.stringify([
		descriptor.name,
		descriptor.filePath,
		descriptor.baseDir,
		descriptor.kind,
		descriptor.python?.importName,
		descriptor.python?.packagePath,
		descriptor.python?.pyprojectPath,
	]);
}

/** The shape alone is never selection authority; callers also require the owned source/epoch. */
export function selectedSkillCapture(
	entry: SessionEntry,
): (SelectedSkillCapture & { producer: "model" | "command" }) | undefined {
	if ((entry.type !== "custom_message" && entry.type !== "custom") || entry.customType !== SELECTED_SKILL_CUSTOM_TYPE)
		return;
	const details = (entry.type === "custom_message" ? entry.details : entry.data) as
		| { baseContextSelectedSkill?: unknown }
		| undefined;
	const value = details?.baseContextSelectedSkill;
	const content = entry.type === "custom_message" ? entry.content : (entry.data as { content?: unknown })?.content;
	if (
		!value ||
		typeof value !== "object" ||
		!("version" in value) ||
		value.version !== 1 ||
		!("descriptor" in value) ||
		!("producer" in value) ||
		(value.producer !== "model" && value.producer !== "command")
	)
		throw new Error("Selected skill capture is unavailable");
	const descriptor = value.descriptor as SelectedSkillDescriptor;
	if (
		!descriptor ||
		typeof descriptor.name !== "string" ||
		typeof descriptor.description !== "string" ||
		typeof descriptor.filePath !== "string" ||
		typeof descriptor.baseDir !== "string" ||
		typeof descriptor.disableModelInvocation !== "boolean" ||
		!["markdown", "python"].includes(descriptor.kind) ||
		typeof content !== "string"
	)
		throw new Error("Selected skill capture is invalid");
	if (
		descriptor.kind === "python" &&
		(!descriptor.python ||
			typeof descriptor.python.importName !== "string" ||
			typeof descriptor.python.packagePath !== "string" ||
			typeof descriptor.python.pyprojectPath !== "string")
	)
		throw new Error("Selected Python skill descriptor is invalid");
	return { descriptor: structuredClone(descriptor), content, producer: value.producer };
}

export function isNativeSkillSelection(source: Pick<IndexedSourceEvent, "qualification" | "retention">): boolean {
	return source.qualification === "native-recovery" && source.retention !== "retained-import";
}

export function sameSelectedSkills(
	left: readonly SelectedSkillReference[] | undefined,
	right: readonly SelectedSkillReference[] | undefined,
): boolean {
	return JSON.stringify(left ?? []) === JSON.stringify(right ?? []);
}

/** Read the existing epoch and any not-yet-admitted selection on this captured literal tail. */
export async function readSkillSelection(
	view: SessionHistoryReadView,
	name: string,
	limits: { maxMessages: number; maxSourceBytes: number },
): Promise<{
	checkpoint?: ContextEpochCheckpoint;
	reference?: SelectedSkillReference;
	capture?: SelectedSkillCapture;
	pending: boolean;
}> {
	let cursor: ContextManifestCursor | undefined;
	let first = true;
	let bytes = 0;
	let count = 0;
	let checkpoint: ContextEpochCheckpoint | undefined;
	let reference: SelectedSkillReference | undefined;
	let capture: SelectedSkillCapture | undefined;
	let pending = false;
	const read = async (source: ContextRef | SelectedSkillReference["view"]["ref"], reader = view) => {
		bytes += source.locator.length;
		if (bytes > limits.maxSourceBytes) throw new Error("Selected skill source byte budget exceeded");
		const metadata = await reader.get(source.entryId);
		if (!metadata || metadata.revision !== source.revision) throw new Error("Selected skill source is unavailable");
		const hydrated = await hydrateCapturedHistoryEntry(metadata, source.locator.length, reader.readPayload);
		if (!hydrated) throw new Error("Selected skill source body is unavailable");
		return hydrated.entry;
	};
	for (;;) {
		const page = await view.contextManifest({ cursor, limit: 128 });
		if (page.selection !== "known") throw new Error("Selected skill context is unavailable");
		if (first) {
			first = false;
			if (page.activeMessageCount + (page.summaryRef ? 1 : 0) > limits.maxMessages)
				throw new Error("Selected skill context item budget exceeded");
			if (page.summaryRef) {
				const entry = await read(page.summaryRef);
				if (
					entry.type === "compaction" &&
					entry.details &&
					typeof entry.details === "object" &&
					CONTEXT_EPOCH_DETAIL in entry.details
				) {
					if (
						page.summaryRef.qualification !== "native-context-epoch" ||
						page.summaryRef.retention === "retained-import"
					)
						throw new Error("Selected skill epoch is not qualified");
					checkpoint = readContextEpoch(entry.details, limits.maxSourceBytes);
					reference = checkpoint?.selectedSkills?.find((item) => item.name === name);
				}
			}
		}
		for (const ref of page.refs) {
			if (++count > limits.maxMessages) throw new Error("Selected skill context item budget exceeded");
			if (
				ref.kind !== "custom_message" ||
				!isNativeSkillSelection(ref) ||
				reference?.view.ref.entryId === ref.entryId
			)
				continue;
			const selected = selectedSkillCapture(await read(ref));
			if (
				!selected ||
				selected.producer !== "model" ||
				selected.descriptor.name !== name ||
				(checkpoint && ref.sequence <= checkpoint.source.sourceSequence)
			)
				continue;
			capture = selected;
			reference = {
				name,
				view: {
					source: view.source,
					ref: { ...ref, kind: ref.kind },
					sourceRevision: JSON.stringify([ref.revision]),
				},
			};
			pending = true;
		}
		if (!page.nextCursor) break;
		if (!page.refs.length) throw new Error("Selected skill context did not advance");
		cursor = page.nextCursor;
	}
	if (reference && !capture) {
		if (!view.atSnapshot) throw new Error("Selected skill epoch requires its original prefix");
		const prefix = await view.atSnapshot(reference.view.source);
		capture = selectedSkillCapture(await read(reference.view.ref, prefix));
		if (
			!capture ||
			capture.descriptor.name !== name ||
			reference.view.sourceRevision !== JSON.stringify([reference.view.ref.revision])
		)
			throw new Error("Selected skill epoch source does not match its capture");
	}
	return { checkpoint, reference, capture, pending };
}

export function selectedSkillBlock(capture: SelectedSkillCapture, ref?: string): string {
	const { descriptor } = capture;
	const version = ref ? ` source_ref="${ref}"` : "";
	return `<skill name="${descriptor.name}" location="${descriptor.filePath}"${version}>\nReferences are relative to ${descriptor.baseDir}.\n\n${stripFrontmatter(capture.content).trim()}\n</skill>`;
}
