/**
 * Model resolution, scoping, and initial selection
 */

import type { ThinkingLevel } from "@ponythewhite/base-context-agent";
import { type Api, getLogger, type Model, modelsAreEqual } from "@ponythewhite/base-context-ai";
import chalk from "chalk";
import { minimatch } from "minimatch";
import { isValidThinkingLevel } from "../cli/args.js";
import { APP_NAME } from "../config.js";
import { DEFAULT_THINKING_LEVEL } from "./defaults.js";
import type { ModelRegistry } from "./model-registry.js";

const log = getLogger("coding-agent.model-resolver");

export interface ScopedModel {
	model: Model<Api>;
	/** Thinking level if explicitly specified in pattern (e.g., "model:high"), undefined otherwise */
	thinkingLevel?: ThinkingLevel;
}

/**
 * Helper to check if a model ID looks like an alias (no date suffix)
 * Dates are typically in format: -20241022 or -20250929
 */
function isAlias(id: string): boolean {
	if (id.endsWith("-latest")) return true;
	const datePattern = /-\d{8}$/;
	return !datePattern.test(id);
}

/**
 * Find an exact model reference match.
 * Supports either a bare model id or a canonical provider/modelId reference.
 * When matching by bare id, ambiguous matches across providers are rejected.
 */
export function findExactModelReferenceMatch(
	modelReference: string,
	availableModels: Model<Api>[],
): Model<Api> | undefined {
	const trimmedReference = modelReference.trim();
	if (!trimmedReference) {
		return undefined;
	}

	const normalizedReference = trimmedReference.toLowerCase();

	const canonicalMatches = availableModels.filter(
		(model) => `${model.provider}/${model.id}`.toLowerCase() === normalizedReference,
	);
	if (canonicalMatches.length === 1) {
		return canonicalMatches[0];
	}
	if (canonicalMatches.length > 1) {
		return undefined;
	}

	const slashIndex = trimmedReference.indexOf("/");
	if (slashIndex !== -1) {
		const provider = trimmedReference.substring(0, slashIndex).trim();
		const modelId = trimmedReference.substring(slashIndex + 1).trim();
		if (provider && modelId) {
			const providerMatches = availableModels.filter(
				(model) =>
					model.provider.toLowerCase() === provider.toLowerCase() &&
					model.id.toLowerCase() === modelId.toLowerCase(),
			);
			if (providerMatches.length === 1) {
				return providerMatches[0];
			}
			if (providerMatches.length > 1) {
				return undefined;
			}
		}
	}

	const idMatches = availableModels.filter((model) => model.id.toLowerCase() === normalizedReference);
	return idMatches.length === 1 ? idMatches[0] : undefined;
}

/**
 * Try to match a pattern to a model from the available models list.
 * Returns the matched model or undefined if no match found.
 */
function tryMatchModel(modelPattern: string, availableModels: Model<Api>[]): Model<Api> | undefined {
	const exactMatch = findExactModelReferenceMatch(modelPattern, availableModels);
	if (exactMatch) {
		return exactMatch;
	}
	const matches = availableModels.filter(
		(m) =>
			m.id.toLowerCase().includes(modelPattern.toLowerCase()) ||
			m.name?.toLowerCase().includes(modelPattern.toLowerCase()),
	);

	if (matches.length === 0) {
		return undefined;
	}
	const aliases = matches.filter((m) => isAlias(m.id));
	const datedVersions = matches.filter((m) => !isAlias(m.id));

	if (aliases.length > 0) {
		aliases.sort((a, b) => b.id.localeCompare(a.id));
		return aliases[0];
	} else {
		datedVersions.sort((a, b) => b.id.localeCompare(a.id));
		return datedVersions[0];
	}
}

interface ParsedModelResult {
	model: Model<Api> | undefined;
	/** Thinking level if explicitly specified in pattern, undefined otherwise */
	thinkingLevel?: ThinkingLevel;
	warning: string | undefined;
}

/**
 * Parse a pattern to extract model and thinking level.
 * Handles models with colons in their IDs (e.g., OpenRouter's :exacto suffix).
 *
 * Algorithm:
 * 1. Try to match full pattern as a model
 * 2. If found, return it with "off" thinking level
 * 3. If not found and has colons, split on last colon:
 *    - If suffix is valid thinking level, use it and recurse on prefix
 *    - If suffix is invalid, warn and recurse on prefix with "off"
 */
function parseModelPattern(
	pattern: string,
	availableModels: Model<Api>[],
	options?: { allowInvalidThinkingLevelFallback?: boolean },
): ParsedModelResult {
	const exactMatch = tryMatchModel(pattern, availableModels);
	if (exactMatch) {
		return { model: exactMatch, thinkingLevel: undefined, warning: undefined };
	}
	const lastColonIndex = pattern.lastIndexOf(":");
	if (lastColonIndex === -1) {
		return { model: undefined, thinkingLevel: undefined, warning: undefined };
	}

	const prefix = pattern.substring(0, lastColonIndex);
	const suffix = pattern.substring(lastColonIndex + 1);

	if (isValidThinkingLevel(suffix)) {
		const result = parseModelPattern(prefix, availableModels, options);
		if (result.model) {
			return {
				model: result.model,
				thinkingLevel: result.warning ? undefined : suffix,
				warning: result.warning,
			};
		}
		return result;
	} else {
		const allowFallback = options?.allowInvalidThinkingLevelFallback ?? true;
		if (!allowFallback) {
			// In strict mode (CLI --model parsing), treat it as part of the model id and fail.
			// This avoids accidentally resolving to a different model.
			return { model: undefined, thinkingLevel: undefined, warning: undefined };
		}
		const result = parseModelPattern(prefix, availableModels, options);
		if (result.model) {
			return {
				model: result.model,
				thinkingLevel: undefined,
				warning: `Invalid thinking level "${suffix}" in pattern "${pattern}". Using default instead.`,
			};
		}
		return result;
	}
}

/**
 * Resolve model patterns to actual Model objects with optional thinking levels
 * Format: "pattern:level" where :level is optional
 * For each pattern, finds all matching models and picks the best version:
 * 1. Prefer alias (e.g., claude-sonnet-4-5) over dated versions (claude-sonnet-4-5-20250929)
 * 2. If no alias, pick the latest dated version
 *
 * Supports models with colons in their IDs (e.g., OpenRouter's model:exacto).
 * The algorithm tries to match the full pattern first, then progressively
 * strips colon-suffixes to find a match.
 */
export function resolveModelScopeFromModels(patterns: string[], availableModels: Model<Api>[]): ScopedModel[] {
	const scopedModels: ScopedModel[] = [];

	for (const pattern of patterns) {
		if (pattern.includes("*") || pattern.includes("?") || pattern.includes("[")) {
			const colonIdx = pattern.lastIndexOf(":");
			let globPattern = pattern;
			let thinkingLevel: ThinkingLevel | undefined;

			if (colonIdx !== -1) {
				const suffix = pattern.substring(colonIdx + 1);
				if (isValidThinkingLevel(suffix)) {
					thinkingLevel = suffix;
					globPattern = pattern.substring(0, colonIdx);
				}
			}
			// This allows "*sonnet*" to match without requiring "anthropic/*sonnet*"
			const matchingModels = availableModels.filter((m) => {
				const fullId = `${m.provider}/${m.id}`;
				return minimatch(fullId, globPattern, { nocase: true }) || minimatch(m.id, globPattern, { nocase: true });
			});

			if (matchingModels.length === 0) {
				log.warn("no models match pattern", { pattern });
				console.warn(chalk.yellow(`Warning: No models match pattern "${pattern}"`));
				continue;
			}

			for (const model of matchingModels) {
				if (!scopedModels.find((sm) => modelsAreEqual(sm.model, model))) {
					scopedModels.push({ model, thinkingLevel });
				}
			}
			continue;
		}

		const { model, thinkingLevel, warning } = parseModelPattern(pattern, availableModels);

		if (warning) {
			log.warn(warning, { pattern });
			console.warn(chalk.yellow(`Warning: ${warning}`));
		}

		if (!model) {
			log.warn("no models match pattern", { pattern });
			console.warn(chalk.yellow(`Warning: No models match pattern "${pattern}"`));
			continue;
		}
		if (!scopedModels.find((sm) => modelsAreEqual(sm.model, model))) {
			scopedModels.push({ model, thinkingLevel });
		}
	}

	return scopedModels;
}

export async function resolveModelScope(patterns: string[], modelRegistry: ModelRegistry): Promise<ScopedModel[]> {
	const availableModels = await modelRegistry.refreshAvailableModels();
	return resolveModelScopeFromModels(patterns, availableModels);
}

export interface ResolveCliModelResult {
	model: Model<Api> | undefined;
	thinkingLevel?: ThinkingLevel;
	warning: string | undefined;
	/**
	 * Error message suitable for CLI display.
	 * When set, model will be undefined.
	 */
	error: string | undefined;
}

/**
 * Resolve a single model from CLI flags.
 *
 * Supports:
 * - --provider <provider> --model <pattern>
 * - --model <provider>/<pattern>
 * - Fuzzy matching (same rules as model scoping: exact id, then partial id/name)
 *
 * Note: This does not apply the thinking level by itself, but it may *parse* and
 * return a thinking level from "<pattern>:<thinking>" so the caller can apply it.
 */
export function resolveCliModel(options: {
	cliProvider?: string;
	cliModel?: string;
	modelRegistry: ModelRegistry;
}): ResolveCliModelResult {
	const { cliProvider, cliModel, modelRegistry } = options;
	if (!cliModel) {
		return { model: undefined, warning: undefined, error: undefined };
	}

	// Include configured models without auth so --api-key can complete first-time setup.
	const allModels = modelRegistry.getAll();
	if (allModels.length === 0) {
		return {
			model: undefined,
			warning: undefined,
			error: "No models available. Add a supported model to models.json.",
		};
	}
	const providerMap = new Map(allModels.map((model) => [model.provider.toLowerCase(), model.provider]));
	const slashIndex = cliModel.indexOf("/");
	const requestedProvider = cliProvider ?? (slashIndex > 0 ? cliModel.substring(0, slashIndex) : undefined);
	const provider = requestedProvider ? providerMap.get(requestedProvider.toLowerCase()) : undefined;
	if (!provider) {
		return {
			model: undefined,
			warning: undefined,
			error: requestedProvider
				? `Unknown provider "${requestedProvider}". Use "${APP_NAME} model list" to see supported providers/models.`
				: `Choose a provider with --provider or use --model provider/model. Use "${APP_NAME} model list" to see supported choices.`,
		};
	}

	const prefix = `${provider}/`;
	const pattern = cliModel.toLowerCase().startsWith(prefix.toLowerCase())
		? cliModel.substring(prefix.length)
		: cliModel;
	const candidates = allModels.filter((model) => model.provider === provider);
	const { model, thinkingLevel, warning } = parseModelPattern(pattern, candidates, {
		allowInvalidThinkingLevelFallback: false,
	});
	return {
		model,
		thinkingLevel,
		warning,
		error: model
			? undefined
			: `Model "${provider}/${pattern}" not found. Use "${APP_NAME} model list" to see supported models, or register it in models.json.`,
	};
}

export interface InitialModelResult {
	model: Model<Api> | undefined;
	thinkingLevel: ThinkingLevel;
	fallbackMessage: string | undefined;
}

/** Restore an explicit CLI or saved selection. A model scope only constrains the available choices. */
export async function findInitialModel(options: {
	cliProvider?: string;
	cliModel?: string;
	scopedModels: ScopedModel[];
	isContinuing: boolean;
	defaultProvider?: string;
	defaultModelId?: string;
	defaultThinkingLevel?: ThinkingLevel;
	modelRegistry: ModelRegistry;
}): Promise<InitialModelResult> {
	const { cliProvider, cliModel, scopedModels, isContinuing, defaultProvider, defaultModelId, modelRegistry } =
		options;
	const thinkingLevel = options.defaultThinkingLevel ?? DEFAULT_THINKING_LEVEL;
	if (cliModel) {
		const resolved = resolveCliModel({ cliProvider, cliModel, modelRegistry });
		if (resolved.error) {
			throw new Error(resolved.error);
		}
		return {
			model: resolved.model,
			thinkingLevel: resolved.thinkingLevel ?? thinkingLevel,
			fallbackMessage: undefined,
		};
	}
	const selected = defaultProvider && defaultModelId ? modelRegistry.find(defaultProvider, defaultModelId) : undefined;
	const model =
		selected &&
		(!cliProvider || selected.provider === cliProvider) &&
		(isContinuing || scopedModels.length === 0 || scopedModels.some((entry) => modelsAreEqual(entry.model, selected)))
			? selected
			: undefined;
	return { model, thinkingLevel, fallbackMessage: undefined };
}
