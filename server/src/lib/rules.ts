// This is the conditional rule compiler. It compiles a structured,
// round-trippable rule list (`x-rules` on the raw schema) into standard
// JSON Schema `allOf`/`if`/`then` blocks for the resolved output. Each rule
// is a single, independent WHEN/THEN condition. There are no AND/OR groups,
// matching the rule builder's UI model.
//
// A field is a dot-path, for example "contact.email". This is the same
// convention used elsewhere in this codebase: x-example-source comment
// paths, and JsonTree's TreeNode.path. JSON Schema expresses nesting only
// one way: nested `properties` keywords. nestAtParent and nestPropertyValue
// below build that nesting.

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
    // Fields that must NOT be present when this rule's condition holds. For
    // example: "if transactionType = CHECK, then creditCardNumber is not a
    // valid field." This compiles straight to `not: { required: [field] } }`.
    // That is a direct JSON Schema concept. It is distinct from "optional":
    // every field is already optional by default. This is "forbidden under
    // this condition."
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

// A rule can reference a field in four places: when.field, then.require[],
// then.forbid[], and then.constrain.field. Every referenced field must
// already be a declared field of the schema: base fields or the schema's
// own fields, at any depth. If a field is not declared, this throws a
// RegistryError (400) naming the first offending field. This blocks the
// save with a clear message, instead of silently writing a bad rule.
// `availableFields` is the flattened set of every valid dot-path (see
// resolver.ts's flattenFieldPaths), not just the top-level keys.
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
      // "None of these fields may be present" means: not (any of them
      // required). Each forbidden field nests at its own parent level.
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
// *parent* of the deepest path segment. Threads through nested `properties`
// for every ancestor.
//
// When `requireAncestors` is true, each intermediate segment is also
// asserted present, via `required`. This is used for WHEN conditions and
// THEN require, where a missing ancestor should mean "does not apply."
//
// When `requireAncestors` is false (THEN forbid, WHEN "absent"), a missing
// ancestor vacuously satisfies the constraint. This is the correct reading
// of "not present."
function nestAtParent(path: string[], leafAtParentLevel: Record<string, unknown>, requireAncestors: boolean): Record<string, unknown> {
  const ancestors = path.slice(0, -1);
  return ancestors.reduceRight<Record<string, unknown>>(
    (acc, segment) =>
      requireAncestors ? { required: [segment], properties: { [segment]: acc } } : { properties: { [segment]: acc } },
    leafAtParentLevel,
  );
}

// Wraps `valueSchema` so it applies as the schema of the field at the very
// end of `path`. Threads `properties` through every segment, including the
// last. Used for THEN constrain's enum. Also used, nested inside
// buildCondition's own nestAtParent call, for a WHEN field's value
// constraint.
function nestPropertyValue(path: string[], valueSchema: Record<string, unknown>): Record<string, unknown> {
  return path.reduceRight<Record<string, unknown>>((acc, segment) => ({ properties: { [segment]: acc } }), valueSchema);
}

// Recursively merges THEN fragments that may collide on a shared ancestor
// path. For example, requiring both "contact.email" and "contact.phone"
// both need properties.contact. `required` arrays are concatenated and
// deduplicated. `properties` objects merge key by key, recursing into
// shared keys. Everything else is last-write-wins. There is normally at
// most one `not` fragment, from forbid.
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
