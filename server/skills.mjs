// SPDX-License-Identifier: Apache-2.0
import { createSkillRegistry } from '../core/skills.mjs';

export { createSkillRegistry, DEFAULT_SKILLS_ROOT } from '../core/skills.mjs';
export const skillRegistry = createSkillRegistry();
// Compatibility export for existing consumers; never includes skill bodies.
export const skills = await skillRegistry.catalog();
