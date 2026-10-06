import { getBundledSkillsDir } from "../packages/coding-agent/src/config.js";
import { ensureKernelPython } from "../packages/coding-agent/src/core/kernel/bootstrap.js";
import { getPythonSkillRuntimeInfo, loadSkillsFromDir } from "../packages/coding-agent/src/core/skills.js";

const { skills } = loadSkillsFromDir({ dir: getBundledSkillsDir(), source: "bundled" });
const python = await ensureKernelPython({ pythonSkills: getPythonSkillRuntimeInfo(skills) });
console.log(`kernel python: ${python}`);
