// A client-side mirror of server/src/lib/rules.ts. Same compilation logic.
// Used only for the live "compiled preview" panel while editing. The server
// is the authority for validation and persistence. This copy never writes
// anything. It only previews what the server would produce.

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

function pathSegments(field: string): string[] {
  return field.split(".");
}

export function compileRules(rules: Rule[]): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [];

  for (const rule of rules) {
    const condition = buildCondition(rule.when);
    const fragments: Record<string, unknown>[] = [];

    for (const field of rule.then.require ?? []) {
      const segments = pathSegments(field);
      const last = segments[segments.length - 1];
      fragments.push(nestAtParent(segments, { required: [last] }, true));
    }

    if (rule.then.constrain) {
      const segments = pathSegments(rule.then.constrain.field);
      fragments.push(nestPropertyValue(segments, { enum: rule.then.constrain.enum }));
    }

    if (rule.then.forbid && rule.then.forbid.length > 0) {
      const anyOf = rule.then.forbid.map((field) => {
        const segments = pathSegments(field);
        const last = segments[segments.length - 1];
        return nestAtParent(segments, { required: [last] }, false);
      });
      fragments.push({ not: { anyOf } });
    }

    const then = mergeSchemaFragments(fragments);
    if (Object.keys(then).length > 0) {
      blocks.push({ if: condition, then });
    }
  }

  return blocks;
}

function buildCondition(when: Rule["when"]): Record<string, unknown> {
  const { field, operator, value } = when;
  const segments = pathSegments(field);
  const last = segments[segments.length - 1];

  if (operator === "present") {
    return nestAtParent(segments, { required: [last] }, true);
  }
  if (operator === "absent") {
    return nestAtParent(segments, { not: { required: [last] } }, false);
  }

  return nestAtParent(segments, { required: [last], properties: { [last]: buildFieldConstraint(operator, value) } }, true);
}

// See server/src/lib/rules.ts for the full rationale. Same logic, kept in
// sync by hand since it is small.
function nestAtParent(path: string[], leafAtParentLevel: Record<string, unknown>, requireAncestors: boolean): Record<string, unknown> {
  const ancestors = path.slice(0, -1);
  return ancestors.reduceRight<Record<string, unknown>>(
    (acc, segment) =>
      requireAncestors ? { required: [segment], properties: { [segment]: acc } } : { properties: { [segment]: acc } },
    leafAtParentLevel,
  );
}

function nestPropertyValue(path: string[], valueSchema: Record<string, unknown>): Record<string, unknown> {
  return path.reduceRight<Record<string, unknown>>((acc, segment) => ({ properties: { [segment]: acc } }), valueSchema);
}

function mergeSchemaFragments(fragments: Record<string, unknown>[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const fragment of fragments) {
    for (const [key, value] of Object.entries(fragment)) {
      if (key === "required" && Array.isArray(value)) {
        const existing = Array.isArray(result.required) ? (result.required as string[]) : [];
        result.required = [...new Set([...existing, ...(value as string[])])];
      } else if (key === "properties" && value && typeof value === "object") {
        const existingProps = (result.properties as Record<string, unknown>) ?? {};
        const incoming = value as Record<string, unknown>;
        const mergedProps: Record<string, unknown> = { ...existingProps };
        for (const [propKey, propSchema] of Object.entries(incoming)) {
          mergedProps[propKey] = existingProps[propKey]
            ? mergeSchemaFragments([existingProps[propKey] as Record<string, unknown>, propSchema as Record<string, unknown>])
            : propSchema;
        }
        result.properties = mergedProps;
      } else {
        result[key] = value;
      }
    }
  }
  return result;
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
