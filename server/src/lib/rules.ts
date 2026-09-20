// Conditional rule builder: compiles a structured, round-trippable rule list
// (`x-rules` on the raw schema) into standard JSON Schema `allOf`/`if`/`then`
// blocks for the resolved output. Each rule is a single independent
// WHEN/THEN condition — no AND/OR groups — matching the builder's UI model.
//
// Fields are dot-paths (e.g. "contact.email"), same convention used
// elsewhere in this codebase (x-example-source comment paths, JsonTree's
// TreeNode.path). Nesting is expressed the only way JSON Schema allows it —
// nested `properties` keywords — via nestAtParent/nestPropertyValue below.

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

function pathSegments(field: string): string[] {
  return field.split(".");
}

// Every field a rule can reference (when.field, then.require[],
// then.forbid[], then.constrain.field) must already be a declared field of
// the schema (base ∪ own, at any depth). Throws a RegistryError (400)
// naming the first offending field, so a bad rule blocks save with a clear
// message rather than being silently written. `availableFields` is the
// flattened set of every valid dot-path (see resolver.ts's
// flattenFieldPaths), not just top-level keys.
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
      // "none of these fields may be present" = not (any of them required),
      // each forbidden field nested at its own parent level.
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

  const fieldSchema = buildFieldConstraint(operator, value);
  return nestAtParent(segments, { required: [last], properties: { [last]: fieldSchema } }, true);
}

// Wraps `leafAtParentLevel` so it applies at the schema level of the
// *parent* of the deepest path segment, threading through nested
// `properties` for every ancestor. When `requireAncestors` is true, each
// intermediate segment is also asserted present (via `required`) — used for
// WHEN conditions and THEN require, where a missing ancestor should mean
// "doesn't apply." When false (THEN forbid, WHEN "absent"), a missing
// ancestor vacuously satisfies the constraint — the correct reading of "not
// present."
function nestAtParent(path: string[], leafAtParentLevel: Record<string, unknown>, requireAncestors: boolean): Record<string, unknown> {
  const ancestors = path.slice(0, -1);
  return ancestors.reduceRight<Record<string, unknown>>(
    (acc, segment) =>
      requireAncestors ? { required: [segment], properties: { [segment]: acc } } : { properties: { [segment]: acc } },
    leafAtParentLevel,
  );
}

// Wraps `valueSchema` so it applies as the schema of the field at the very
// end of `path`, threading `properties` through every segment including the
// last. Used for THEN constrain's enum and (nested inside buildCondition's
// own nestAtParent call) a WHEN field's value constraint.
function nestPropertyValue(path: string[], valueSchema: Record<string, unknown>): Record<string, unknown> {
  return path.reduceRight<Record<string, unknown>>((acc, segment) => ({ properties: { [segment]: acc } }), valueSchema);
}

// Recursively merges THEN fragments that may collide on shared ancestor
// paths (e.g. requiring both "contact.email" and "contact.phone" both need
// properties.contact...). `required` arrays concatenate+dedupe, `properties`
// objects merge key-by-key (recursing into shared keys), everything else is
// last-write-wins (there's normally at most one `not` fragment, from forbid).
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
      throw new RegistryError(`Unsupported rule operator "${operator}".`, 400);
  }
}
