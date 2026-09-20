// Synthesizes a "full" example instance from a *resolved* schema — every
// property populated (required or not), used as the default entry in the
// Examples tab so there's always something to look at even before any
// fixture has been hand-authored.

export function generateFullExample(resolvedSchema: unknown): unknown {
  const schema = resolvedSchema as Record<string, unknown> | undefined;
  const properties = schema?.properties as Record<string, unknown> | undefined;
  if (!properties) return {};

  const result: Record<string, unknown> = {};
  for (const [key, propSchema] of Object.entries(properties)) {
    result[key] = generateValue(propSchema as Record<string, unknown>);
  }
  return result;
}

export function generateValue(schema: Record<string, unknown>): unknown {
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum[0];
  }

  switch (schema.type) {
    case "object": {
      const properties = schema.properties as Record<string, unknown> | undefined;
      if (!properties) return {};
      const obj: Record<string, unknown> = {};
      for (const [key, propSchema] of Object.entries(properties)) {
        obj[key] = generateValue(propSchema as Record<string, unknown>);
      }
      return obj;
    }
    case "array": {
      const items = schema.items as Record<string, unknown> | undefined;
      return items ? [generateValue(items)] : [];
    }
    case "number":
    case "integer":
      return typeof schema.minimum === "number" ? schema.minimum : 0;
    case "boolean":
      return true;
    case "string":
      return generateStringValue(schema);
    default:
      return null;
  }
}

function generateStringValue(schema: Record<string, unknown>): string {
  switch (schema.format) {
    case "email":
      return "user@example.com";
    case "date-time":
      return new Date().toISOString();
    case "date":
      return new Date().toISOString().slice(0, 10);
    case "uuid":
      return "00000000-0000-4000-8000-000000000000";
    default:
      return "example";
  }
}
