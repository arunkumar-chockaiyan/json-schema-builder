// Conditional rule builder: compiles a structured, round-trippable rule list
// (`x-rules` on the raw schema) into standard JSON Schema `allOf`/`if`/`then`
// blocks for the resolved output. Each rule is a single independent
// WHEN/THEN condition — no AND/OR groups — matching the builder's UI model.

import { RegistryError } from "../types.js";

export type RuleOperator =
  | "equals"
  | "notEquals"
  | "oneOf"
  | "noneOf"
  | "present"
  | "absent"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "pattern"
  | "minLength"
  | "maxLength";

export interface Rule {
  id: string;
  when: {
    field: string;
    operator: RuleOperator;
    value?: unknown;
  };
  then: {
    require?: string[];
    // Fields that must NOT be present when this rule's condition holds
    // (e.g. "if transactionType = CHECK, then creditCardNumber is not a
    // valid field"). Compiles straight to `not: { required: [field] } }` —
    // a direct JSON Schema concept, distinct from "optional" (every field is
    // optional by default already; this is "forbidden under this condition").
    forbid?: string[];
    constrain?: {
      field: string;
      enum: unknown[];
    };
  };
}

// Every field a rule can reference (when.field, then.require[],
// then.forbid[], then.constrain.field) must already be a declared property
// of the schema (base ∪ own). Throws a RegistryError (400) naming the first
// offending field, so a bad rule blocks save with a clear message rather
// than being silently written.
export function validateRules(rules: Rule[], availableFields: Set<string>): void {
  for (const rule of rules) {
    const referenced = [
      rule.when.field,
      ...(rule.then.require ?? []),
      ...(rule.then.forbid ?? []),
      ...(rule.then.constrain ? [rule.then.constrain.field] : []),
    ];
    for (const field of referenced) {
      if (!availableFields.has(field)) {
        throw new RegistryError(
          `Rule "${rule.id}" references unknown field "${field}". Fields must already be declared on the schema.`,
          400,
        );
      }
    }
  }
}

export function compileRules(rules: Rule[]): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [];

  for (const rule of rules) {
    const condition = buildCondition(rule.when);
    const then: Record<string, unknown> = {};

    if (rule.then.require && rule.then.require.length > 0) {
      then.required = rule.then.require;
    }
    if (rule.then.constrain) {
      then.properties = {
        [rule.then.constrain.field]: { enum: rule.then.constrain.enum },
      };
    }
    if (rule.then.forbid && rule.then.forbid.length > 0) {
      // "none of these fields may be present" = not (any of them required)
      then.not = { anyOf: rule.then.forbid.map((field) => ({ required: [field] })) };
    }

    if (Object.keys(then).length > 0) {
      blocks.push({ if: condition, then });
    }
  }

  return blocks;
}

function buildCondition(when: Rule["when"]): Record<string, unknown> {
  const { field, operator, value } = when;

  if (operator === "present") {
    return { required: [field] };
  }
  if (operator === "absent") {
    return { not: { required: [field] } };
  }

  const fieldSchema = buildFieldConstraint(operator, value);
  return {
    required: [field],
    properties: { [field]: fieldSchema },
  };
}

function buildFieldConstraint(operator: RuleOperator, value: unknown): Record<string, unknown> {
  switch (operator) {
    case "equals":
      return { const: value };
    case "notEquals":
      return { not: { const: value } };
    case "oneOf":
      return { enum: value };
    case "noneOf":
      return { not: { enum: value } };
    case "gt":
      return { exclusiveMinimum: value };
    case "gte":
      return { minimum: value };
    case "lt":
      return { exclusiveMaximum: value };
    case "lte":
      return { maximum: value };
    case "pattern":
      return { pattern: value };
    case "minLength":
      return { minLength: value };
    case "maxLength":
      return { maxLength: value };
    default:
      throw new RegistryError(`Unsupported rule operator "${operator}".`, 400);
  }
}
