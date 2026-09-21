import type { Skill } from "@wappy/core";

/** Registered Skills (prompt fragment + tools + optional memory schema, §17), keyed by name. */
export interface SkillRegistry {
  register(skill: Skill): void;
  get(name: string): Skill | undefined;
  list(): Skill[];
  /** Names of every registered skill — what the Agent hands the Router as `RouterInput.availableSkills`. */
  names(): string[];
}

export function createSkillRegistry(): SkillRegistry {
  const skills = new Map<string, Skill>();
  return {
    register(skill) {
      if (skills.has(skill.name)) throw new Error(`SkillRegistry: skill "${skill.name}" is already registered`);
      skills.set(skill.name, skill);
    },
    get: (name) => skills.get(name),
    list: () => [...skills.values()],
    names: () => [...skills.keys()],
  };
}
