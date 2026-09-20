// Client-side mirror of server/src/lib/rules.ts — same compilation logic,
// used here only for the live "compiled preview" panel while editing. The
// server is the authority for validation/persistence; this copy never writes
// anything, it just previews what the server would produce.

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
    // Fields that must NOT be present when this rule's condition holds.
    forbid?: string[];
    constrain?: {
      field: string;
      enum: unknown[];
    };
  };
}

export const OPERATOR_LABELS: Record<RuleOperator, string> = {
  equals: "equals",
  notEquals: "not equals",
  oneOf: "is one of",
  noneOf: "is none of",
  present: "is present",
  absent: "is absent",
  gt: "> (greater than)",
  gte: ">= (at least)",
  lt: "< (less than)",
  lte: "<= (at most)",
  pattern: "matches pattern",
  minLength: "min length",
  maxLength: "max length",
};

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

  return {
    required: [field],
    properties: { [field]: buildFieldConstraint(operator, value) },
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
      return {};
  }
}

export function newRuleId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `rule-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
