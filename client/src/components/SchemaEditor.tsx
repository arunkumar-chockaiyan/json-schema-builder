import { useEffect, useMemo, useState } from "react";
import Editor from "@monaco-editor/react";
import { api } from "../api/client";
import type { Selection } from "../App";
import { RuleBuilder, FieldMultiPicker, type FieldInfo } from "./RuleBuilder";
import { JsonTree, buildExampleTree, buildSchemaTree } from "./JsonTree";
import { ComponentLinkPicker } from "./ComponentLinkPicker";
import type { Rule } from "../rules";

interface Props {
  family: string;
  // SchemaEditor never receives "newSchema" or "extractComponent" — App.tsx
  // routes those selections to NewSchemaForm / ExtractComponentForm instead.
  selection: Exclude<Selection, { kind: "newSchema" } | { kind: "extractComponent" }>;
}

// Schemas get the two-pane layout: left = editable (annotated example Input
// + Rules), right = read-only verification (generated Schema + Examples
// gallery). Base/Component get a simpler two-pane variant: left = editable
// raw JSON (no Input/Rules distinction — they're hand-edited, not
// example-derived), right = just a single generated Example (no dropdown,
// not persisted — see server/src/lib/exampleGenerator.ts). Base's left
// editor is locked by default (editing it affects every schema in the
// family at once) — an explicit "Enable editing" action in the warning
// banner unlocks it.
type LeftTab = "input" | "rules";
type RightTab = "source" | "examples";

function safeParse(json: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// Walks the schema's own raw properties/required tree (not resolved — a
// $ref node has no properties/required of its own to recurse into, which
// correctly excludes a component's own required fields; those are the
// component's business, not this schema's `-- required` comments) and
// collects every dot-path made required via the example's `-- required`
// comment directive, at any depth.
function collectCommentRequiredPaths(node: Record<string, unknown> | null | undefined, prefix = ""): string[] {
  if (!node) return [];
  const required = Array.isArray(node.required) ? (node.required as string[]) : [];
  const properties = (node.properties as Record<string, unknown>) ?? {};
  const paths = required.map((key) => (prefix ? `${prefix}.${key}` : key));
  for (const [key, child] of Object.entries(properties)) {
    const childPath = prefix ? `${prefix}.${key}` : key;
    paths.push(...collectCommentRequiredPaths(child as Record<string, unknown>, childPath));
  }
  return paths;
}

// Splits a line into JSON code + trailing "-- comment", mirroring the
// server's parser (server/src/lib/example.ts's splitTrailingComment)
// closely enough for editing — string-literal aware so a "--" inside a
// value isn't mistaken for a comment start.
function splitTrailingComment(line: string): { code: string; comment: string | null } {
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && line[i - 1] !== "\\") {
      inString = !inString;
      continue;
    }
    if (!inString && ch === "-" && line[i + 1] === "-") {
      return { code: line.slice(0, i), comment: line.slice(i + 2).trim() };
    }
  }
  return { code: line, comment: null };
}

function stripRequiredDirective(commentText: string | undefined): string | undefined {
  if (!commentText) return undefined;
  const parts = commentText
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.toLowerCase() !== "required");
  return parts.length > 0 ? parts.join("; ") : undefined;
}

const COMPONENT_FRAGMENT = /^component:\s*/i;

function stripComponentDirective(commentText: string | undefined): string | undefined {
  if (!commentText) return undefined;
  const parts = commentText
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !COMPONENT_FRAGMENT.test(s));
  return parts.length > 0 ? parts.join("; ") : undefined;
}

function mergeComponentDirective(commentText: string | undefined, componentName: string): string {
  const parts = (commentText ?? "")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !COMPONENT_FRAGMENT.test(s));
  parts.push(`component: ${componentName}`);
  return parts.join("; ");
}

// Locates the comment governing `targetPath` in the annotated example —
// either a trailing comment on the field's own line, or a standalone
// comment line immediately above it (the two forms
// server/src/lib/example.ts's stripComments recognizes) — and rewrites it
// via `transform`: given the comment's current text (undefined if there
// isn't one), return the new text, or undefined to remove the comment
// entirely. If there's no comment yet and `transform` returns text, it's
// added as a fresh trailing comment on the key's own line (works even for a
// multi-line object value — a trailing comment on the opening-brace line
// doesn't affect nesting tracking below).
function editFieldComment(
  source: string,
  targetPath: string,
  transform: (existing: string | undefined) => string | undefined,
): string {
  const lines = source.split("\n");
  const pathStack: string[] = [];
  const KEY_LINE = /^\s*"([^"]+)"\s*:\s*(.*?)\s*,?\s*$/;
  const outLines: (string | null)[] = [];
  let pendingCommentIndex: number | null = null;

  for (const line of lines) {
    const { code, comment } = splitTrailingComment(line);
    const trimmedCode = code.trim();

    if (trimmedCode.length === 0) {
      outLines.push(line);
      pendingCommentIndex = comment ? outLines.length - 1 : null;
      continue;
    }

    const match = KEY_LINE.exec(trimmedCode);
    if (match) {
      const key = match[1];
      const valueStart = match[2];
      const path = [...pathStack, key].join(".");

      if (path === targetPath) {
        if (comment) {
          const newComment = transform(comment);
          outLines.push(newComment ? `${code}-- ${newComment}` : code.replace(/\s+$/, ""));
        } else if (pendingCommentIndex !== null) {
          const prevLine = outLines[pendingCommentIndex] as string;
          const { code: prevCode, comment: prevComment } = splitTrailingComment(prevLine);
          const newComment = transform(prevComment ?? undefined);
          outLines[pendingCommentIndex] = newComment ? `${prevCode}-- ${newComment}` : null;
          outLines.push(line);
        } else {
          const newComment = transform(undefined);
          outLines.push(newComment ? `${code.replace(/\s+$/, "")}  -- ${newComment}` : line);
        }
      } else {
        outLines.push(line);
      }

      pendingCommentIndex = null;
      if (valueStart.startsWith("{") && !valueStart.includes("}")) {
        pathStack.push(key);
      }
    } else {
      outLines.push(line);
      pendingCommentIndex = null;
    }

    if (trimmedCode === "}" || trimmedCode === "},") {
      pathStack.pop();
    }
  }

  return outLines.filter((l): l is string => l !== null).join("\n");
}

// Removes the `required` directive from whichever comment currently marks
// `targetPath` as required. Keeps any description text the comment also
// carried; leaves everything else untouched. Used so removing a field from
// the Required fields picker actually sticks, instead of the comment
// silently re-adding it on the next Apply.
function removeRequiredDirective(source: string, targetPath: string): string {
  return editFieldComment(source, targetPath, stripRequiredDirective);
}

// Adds or replaces the `component: <name>` directive on `targetPath`'s
// comment — used to link (or reassign) a field to a component from the
// Component links picker without hand-typing the directive.
function setComponentDirective(source: string, targetPath: string, componentName: string): string {
  return editFieldComment(source, targetPath, (existing) => mergeComponentDirective(existing, componentName));
}

// Removes the `component: <name>` directive from `targetPath`'s comment.
// For a TOP-LEVEL path this alone does not make the field's schema revert
// to an inferred inline shape — deriveProperties (server/src/lib/example.ts)
// preserves an existing on-disk $ref regardless of the comment, since that's
// the only signal an Extract-Component-created ref has. The caller also
// needs to fold the path into `x-unlink-components` for the next save (see
// handleUnlinkComponent) so the server knows to stop preserving it. Nested
// paths don't need that extra step — the preservation check is top-level
// only.
function removeComponentDirective(source: string, targetPath: string): string {
  return editFieldComment(source, targetPath, stripComponentDirective);
}

const COMPONENT_REF_PATTERN = /^components\/(.+)\.schema\.json$/;

// Walks the schema's own raw properties tree (never resolved — mirrors
// collectCommentRequiredPaths) and records every field whose schema is
// currently a bare $ref, without recursing into it (its internals belong to
// the linked component's own file, not this schema).
function collectComponentLinks(node: Record<string, unknown> | null | undefined, prefix = ""): Map<string, string> {
  const links = new Map<string, string>();
  if (!node) return links;
  const properties = (node.properties as Record<string, unknown>) ?? {};
  for (const [key, child] of Object.entries(properties)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const childSchema = (child ?? {}) as Record<string, unknown>;
    if (typeof childSchema.$ref === "string") {
      const match = COMPONENT_REF_PATTERN.exec(childSchema.$ref);
      if (match) links.set(path, match[1]);
      continue;
    }
    for (const [k, v] of collectComponentLinks(childSchema, path)) links.set(k, v);
  }
  return links;
}

function extractFields(resolvedObj: Record<string, unknown> | null): FieldInfo[] {
  const props = resolvedObj?.properties;
  if (!props || typeof props !== "object") return [];
  return Object.entries(props as Record<string, unknown>).map(([name, schema]) => {
    const s = schema as Record<string, unknown>;
    return {
      name,
      type: typeof s.type === "string" ? s.type : undefined,
      enum: Array.isArray(s.enum) ? s.enum : undefined,
    };
  });
}

const GENERATED_EXAMPLE_KEY = "_generated";
const PRIMARY_EXAMPLE_KEY = "_primary";

export function SchemaEditor({ family, selection }: Props) {
  const [leftTab, setLeftTab] = useState<LeftTab>("input");
  const [rightTab, setRightTab] = useState<RightTab>("source");
  const [baseEditingEnabled, setBaseEditingEnabled] = useState(false);
  const [bcExampleData, setBcExampleData] = useState<unknown>(undefined);
  const [bcExampleLoading, setBcExampleLoading] = useState(false);
  const [bcExampleError, setBcExampleError] = useState<string | null>(null);

  const [raw, setRaw] = useState<string>("");
  const [resolved, setResolved] = useState<string>("");
  const [usedBy, setUsedBy] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");

  const [inputText, setInputText] = useState<string>("{}");

  const [fixtures, setFixtures] = useState<{ name: string; valid: boolean; errorSummary?: string }[]>([]);
  const [repairing, setRepairing] = useState(false);
  const [repairSummary, setRepairSummary] = useState<string | null>(null);
  const [baseRequiredFields, setBaseRequiredFields] = useState<string[]>([]);
  const [availableComponents, setAvailableComponents] = useState<string[]>([]);
  // Comment-required fields whose "-- required" directive was just stripped
  // client-side, hidden optimistically until Save/Apply persists it and a
  // reload recomputes commentRequiredFields for real.
  const [pendingCommentRemovals, setPendingCommentRemovals] = useState<Set<string>>(new Set());
  const [exampleSelection, setExampleSelection] = useState<string>(GENERATED_EXAMPLE_KEY);
  const [exampleData, setExampleData] = useState<unknown>(undefined);
  const [exampleLoading, setExampleLoading] = useState(false);
  const [exampleError, setExampleError] = useState<string | null>(null);

  const isEditable = true;
  const isSchema = selection.kind === "schema";

  const loadSchemaData = async () => {
    if (selection.kind === "base") {
      const detail = await api.getBase(family);
      setRaw(JSON.stringify(detail.raw, null, 2));
      setResolved(JSON.stringify(detail.resolved, null, 2));
      setUsedBy([]);
    } else if (selection.kind === "component") {
      const detail = await api.getComponent(family, selection.name);
      setRaw(JSON.stringify(detail.raw, null, 2));
      setResolved(JSON.stringify(detail.resolved, null, 2));
      setUsedBy(detail.usedBy);
    } else {
      const detail = await api.getSchema(family, selection.name);
      setRaw(JSON.stringify(detail.raw, null, 2));
      setResolved(JSON.stringify(detail.resolved, null, 2));
      setUsedBy([]);
    }
  };

  useEffect(() => {
    setLoading(true);
    setError(null);
    setSaveState("idle");
    setLeftTab("input");
    setRightTab("source");
    setBaseEditingEnabled(false);
    setExampleSelection(GENERATED_EXAMPLE_KEY);
    setPendingCommentRemovals(new Set());

    loadSchemaData()
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [family, selection]);

  // Base/Component's single generated example — computed on demand, not
  // persisted (no example-authoring concept for these, unlike schemas).
  useEffect(() => {
    if (selection.kind !== "base" && selection.kind !== "component") {
      setBcExampleData(undefined);
      return;
    }
    setBcExampleLoading(true);
    setBcExampleError(null);
    const fetcher =
      selection.kind === "base" ? api.getBaseExample(family) : api.getComponentExample(family, selection.name);
    fetcher
      .then(setBcExampleData)
      .catch((err) => setBcExampleError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBcExampleLoading(false));
  }, [family, selection]);

  // Base's required fields — shown as a hint on the Input tab, since the
  // annotated example must include all of them (base is the minimum).
  useEffect(() => {
    if (selection.kind !== "schema") {
      setBaseRequiredFields([]);
      return;
    }
    api
      .getBase(family)
      .then((detail) => {
        const req = (detail.raw as Record<string, unknown>)?.required;
        setBaseRequiredFields(Array.isArray(req) ? (req as string[]) : []);
      })
      .catch(() => setBaseRequiredFields([]));
  }, [family, selection]);

  // Family's existing components — shown as a hint on the Input tab so it's
  // clear what names `-- component: <name>` can point at.
  useEffect(() => {
    if (selection.kind !== "schema") {
      setAvailableComponents([]);
      return;
    }
    api
      .getFamily(family)
      .then((detail) => setAvailableComponents(detail.components))
      .catch(() => setAvailableComponents([]));
  }, [family, selection]);

  // Fixture (saved test case) list, with each one's validity against the
  // schema's *current* resolved output — fixtures are static files, nothing
  // updates them automatically when the schema (or a component/base it
  // depends on) changes, so this is how staleness surfaces. Independent of
  // the source/resolved/rules fetch above so a schema with no fixtures
  // doesn't block those.
  const reloadFixtures = () => {
    if (selection.kind !== "schema") {
      setFixtures([]);
      return;
    }
    api
      .listExamples(family, selection.name)
      .then(({ examples }) => setFixtures(examples))
      .catch((err) => setExampleError(err instanceof Error ? err.message : String(err)));
  };

  useEffect(reloadFixtures, [family, selection]);

  // Right-half Examples tab: reload whenever the dropdown selection (or the
  // schema itself) changes.
  const reloadExampleData = () => {
    if (selection.kind !== "schema") {
      setExampleData(undefined);
      return;
    }
    setExampleLoading(true);
    setExampleError(null);
    const fetcher =
      exampleSelection === GENERATED_EXAMPLE_KEY
        ? api.getGeneratedExample(family, selection.name)
        : exampleSelection === PRIMARY_EXAMPLE_KEY
          ? api.getPrimaryExample(family, selection.name)
          : api.getExample(family, selection.name, exampleSelection);
    fetcher
      .then(setExampleData)
      .catch((err) => setExampleError(err instanceof Error ? err.message : String(err)))
      .finally(() => setExampleLoading(false));
  };

  useEffect(reloadExampleData, [family, selection, exampleSelection]);

  const handleRepairFixtures = async () => {
    if (selection.kind !== "schema") return;
    setRepairing(true);
    setRepairSummary(null);
    try {
      const { repaired } = await api.repairFixtures(family, selection.name);
      const requiredFixedCount = repaired.filter((r) => r.repairedFields.length > 0).length;
      const optionalAddedCount = repaired.filter((r) => r.addedOptionalFields.length > 0).length;
      const stillInvalid = repaired.filter((r) => !r.valid);

      const parts: string[] = [];
      if (requiredFixedCount > 0) {
        parts.push(`fixed ${requiredFixedCount} fixture${requiredFixedCount === 1 ? "" : "s"} missing a required field`);
      }
      if (optionalAddedCount > 0) {
        parts.push(`added new optional fields to ${optionalAddedCount} fixture${optionalAddedCount === 1 ? "" : "s"}`);
      }
      let summary = parts.length > 0 ? `Repaired: ${parts.join("; ")}.` : "Fixtures already match the current schema.";
      if (stillInvalid.length > 0) {
        summary += ` ${stillInvalid.length} still invalid (needs a manual fix — see the fixture's error below).`;
      }
      setRepairSummary(summary);
      reloadFixtures();
      reloadExampleData();
    } catch (err) {
      setRepairSummary(err instanceof Error ? err.message : String(err));
    } finally {
      setRepairing(false);
    }
  };

  // Structured view over `raw` — parses on every raw change so Rules and the
  // Input tab's seed text stay in sync with what's actually persisted.
  const rawObj = useMemo(() => safeParse(raw), [raw]);
  const resolvedObj = useMemo(() => safeParse(resolved), [resolved]);
  const fields = useMemo(() => extractFields(resolvedObj), [resolvedObj]);
  const schemaTreeNodes = useMemo(
    () => buildSchemaTree(resolvedObj?.properties as Record<string, unknown> | undefined),
    [resolvedObj],
  );
  // Own-fields tree for the Component links picker — built from this
  // schema's raw (un-dereferenced) properties, not resolved, so a linked
  // field's internals (which belong to the component's own file) aren't
  // offered as re-linkable targets.
  const ownFieldTreeNodes = useMemo(
    () => buildSchemaTree(rawObj?.properties as Record<string, unknown> | undefined),
    [rawObj],
  );
  const componentLinks = useMemo(() => collectComponentLinks(rawObj), [rawObj]);
  const rules = useMemo(
    () => (Array.isArray(rawObj?.["x-rules"]) ? (rawObj!["x-rules"] as Rule[]) : []),
    [rawObj],
  );
  const requiredFields = useMemo(
    () => (Array.isArray(rawObj?.["x-required-fields"]) ? (rawObj!["x-required-fields"] as string[]) : []),
    [rawObj],
  );
  // Fields required via the example's `-- required` comment directive —
  // filtered by pendingCommentRemovals so a just-edited field disappears
  // immediately instead of waiting for a Save/reload round-trip.
  const commentRequiredFields = useMemo(
    () => collectCommentRequiredPaths(rawObj).filter((f) => !pendingCommentRemovals.has(f)),
    [rawObj, pendingCommentRemovals],
  );
  // The Required fields picker shows one merged, fully-removable list —
  // fields required via the explicit x-required-fields list, and fields
  // required via the example's comment directive, treated the same way.
  const allRequiredFields = useMemo(
    () => Array.from(new Set([...requiredFields, ...commentRequiredFields])),
    [requiredFields, commentRequiredFields],
  );

  // Seed the Input tab's text whenever `raw` (re)loads — from the schema's
  // own x-example-source if it has one, else an empty object to start from.
  useEffect(() => {
    if (!rawObj) return;
    const existing = rawObj["x-example-source"];
    setInputText(typeof existing === "string" ? existing : "{}");
  }, [rawObj]);

  const handleRulesChange = (nextRules: Rule[]) => {
    if (!rawObj) return;
    const nextRaw = { ...rawObj, "x-rules": nextRules };
    setRaw(JSON.stringify(nextRaw, null, 2));
  };

  // The picker shows one merged list (explicit x-required-fields + comment-
  // required), so a single toggle click can mean different things: adding a
  // brand-new field always goes into x-required-fields; removing a field
  // that came from the example's `-- required` comment edits that comment
  // directly (via removeRequiredDirective) so the removal actually sticks,
  // rather than silently reappearing on the next Apply.
  const handleRequiredFieldsChange = (nextRequired: string[]) => {
    if (!rawObj) return;
    const removed = allRequiredFields.filter((f) => !nextRequired.includes(f));
    const added = nextRequired.filter((f) => !allRequiredFields.includes(f));

    let nextInputText = inputText;
    const newPending = new Set(pendingCommentRemovals);
    for (const field of removed) {
      if (commentRequiredFields.includes(field) && !requiredFields.includes(field)) {
        nextInputText = removeRequiredDirective(nextInputText, field);
        newPending.add(field);
      }
    }

    const nextExplicit = [...requiredFields.filter((f) => !removed.includes(f)), ...added];
    const nextRaw: Record<string, unknown> = { ...rawObj, "x-required-fields": nextExplicit };

    if (nextInputText !== inputText) {
      nextRaw["x-example-source"] = nextInputText;
      setInputText(nextInputText);
      setPendingCommentRemovals(newPending);
    }

    setRaw(JSON.stringify(nextRaw, null, 2));
  };

  // Links (or reassigns) `path` to `componentName` — writes/replaces the
  // `component: <name>` directive on that field's comment. No unlink signal
  // needed even when reassigning: a fresh directive always takes priority
  // over whatever the on-disk $ref currently is (see server/src/lib/
  // example.ts's deriveProperties — componentRefs is checked before the
  // preserve-existing-$ref fallback).
  const handleLinkComponent = (path: string, componentName: string) => {
    if (!rawObj) return;
    const nextInputText = setComponentDirective(inputText, path, componentName);
    const nextRaw: Record<string, unknown> = { ...rawObj, "x-example-source": nextInputText };
    setInputText(nextInputText);
    setRaw(JSON.stringify(nextRaw, null, 2));
  };

  // Unlinks `path` — removes the directive comment and, for a top-level
  // path only, also queues it in x-unlink-components so the next Apply
  // doesn't preserve the still-on-disk $ref (see removeComponentDirective).
  const handleUnlinkComponent = (path: string) => {
    if (!rawObj) return;
    const nextInputText = removeComponentDirective(inputText, path);
    const nextRaw: Record<string, unknown> = { ...rawObj, "x-example-source": nextInputText };
    if (!path.includes(".")) {
      const existingUnlink = Array.isArray(rawObj["x-unlink-components"])
        ? (rawObj["x-unlink-components"] as string[])
        : [];
      nextRaw["x-unlink-components"] = Array.from(new Set([...existingUnlink, path]));
    }
    setInputText(nextInputText);
    setRaw(JSON.stringify(nextRaw, null, 2));
  };

  const persistAndReload = async (nextContent: Record<string, unknown>) => {
    setSaveState("saving");
    setError(null);
    try {
      if (selection.kind === "base") {
        await api.saveBase(family, nextContent);
      } else if (selection.kind === "component") {
        await api.saveComponent(family, selection.name, nextContent);
      } else if (selection.kind === "schema") {
        await api.saveSchema(family, selection.name, nextContent);
      }
      await loadSchemaData();
      setPendingCommentRemovals(new Set());
      setSaveState("saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaveState("idle");
    }
  };

  // Single-pane Save — Base and Component both edit raw JSON text directly.
  const handleSingleSave = async () => {
    if (!isEditable) return;
    try {
      await persistAndReload(JSON.parse(raw));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaveState("idle");
    }
  };

  // Two-pane Save: what gets sent depends on which left tab is active —
  // Input applies the annotated example text (the server derives
  // properties/required from it), Rules applies whatever's already been
  // edited into `raw` via handleRulesChange.
  const handleTwoPaneSave = async () => {
    if (!rawObj) return;
    const nextContent =
      leftTab === "input" ? { ...rawObj, "x-example-source": inputText } : rawObj;
    await persistAndReload(nextContent);
  };

  const title = selection.kind === "base" ? "base.schema.json" : selection.name;

  if (loading) {
    return (
      <div className="editor-pane">
        <div className="editor-toolbar">
          <h3>{title}</h3>
        </div>
        <div className="panel">Loading...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="editor-pane">
        <div className="editor-toolbar">
          <h3>{title}</h3>
        </div>
        <div className="panel error">{error}</div>
      </div>
    );
  }

  if (!isSchema) {
    const isBase = selection.kind === "base";
    const baseLocked = isBase && !baseEditingEnabled;

    return (
      <div className="editor-pane">
        <div className="editor-toolbar">
          <h3>{title}</h3>
          <button className="save-button" onClick={handleSingleSave} disabled={saveState === "saving" || baseLocked}>
            {saveState === "saving" ? "Saving..." : saveState === "saved" ? "Saved ✓" : "Save"}
          </button>
        </div>

        <div className="editor-split">
          <div className="editor-split-left">
            {isBase && (
              <div className="usage-banner">
                Locked — merged into every schema in this family. Changing it affects all of them immediately.
                {baseLocked && (
                  <button className="enable-edit-button" onClick={() => setBaseEditingEnabled(true)}>
                    Enable editing
                  </button>
                )}
              </div>
            )}
            {selection.kind === "component" && usedBy.length > 0 && (
              <div className="usage-banner">Used by (transitively): {usedBy.join(", ")}</div>
            )}
            <Editor
              height="60vh"
              defaultLanguage="json"
              value={raw}
              onChange={(value) => {
                if (!baseLocked) setRaw(value ?? "");
              }}
              options={{ readOnly: baseLocked, minimap: { enabled: false } }}
            />
          </div>

          <div className="editor-split-right">
            <div className="example-tab">
              <h4>Example</h4>
              {bcExampleError && <div className="panel error">{bcExampleError}</div>}
              {bcExampleLoading ? (
                <div className="panel">Loading example...</div>
              ) : (
                <JsonTree nodes={buildExampleTree(bcExampleData)} defaultExpandedDepth={2} />
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  const hasPrimaryExample = typeof rawObj?.["x-example-source"] === "string";
  const exampleOptions = [
    GENERATED_EXAMPLE_KEY,
    ...(hasPrimaryExample ? [PRIMARY_EXAMPLE_KEY] : []),
    ...fixtures.map((f) => f.name),
  ];
  const selectedFixture = fixtures.find((f) => f.name === exampleSelection);

  return (
    <div className="editor-pane">
      <div className="editor-toolbar">
        <h3>{title}</h3>
        <button className="repair-button" onClick={handleRepairFixtures} disabled={repairing}>
          {repairing ? "Refreshing..." : "Refresh Examples"}
        </button>
        <button className="save-button" onClick={handleTwoPaneSave} disabled={saveState === "saving"}>
          {saveState === "saving" ? "Saving..." : saveState === "saved" ? "Saved ✓" : leftTab === "input" ? "Apply" : "Save"}
        </button>
      </div>
      {repairSummary && <p className="muted repair-summary">{repairSummary}</p>}

      <div className="editor-split">
        <div className="editor-split-left">
          <div className="tabs">
            <button className={leftTab === "input" ? "active" : ""} onClick={() => setLeftTab("input")}>
              Input
            </button>
            <button className={leftTab === "rules" ? "active" : ""} onClick={() => setLeftTab("rules")}>
              Constraints{" "}
              {(rules.length > 0 || requiredFields.length > 0 || componentLinks.size > 0) &&
                `(${rules.length + requiredFields.length + componentLinks.size})`}
            </button>
          </div>

          {leftTab === "input" ? (
            <>
              <div className="muted split-hint">
                <p>Type an example for this schema.</p>
                <ul>
                  <li>
                    To add a description to a field, type <code>-- text</code> after it.
                  </li>
                  <li>Fields are optional by default.</li>
                  <li>
                    To make a field required, type <code>-- required</code>.
                  </li>
                  <li>
                    To add a description too, type <code>-- required; text</code>.
                  </li>
                  <li>
                    To create an enum, type values separated by commas, for example <code>"card,check"</code>. The
                    first value becomes the example value.
                  </li>
                  <li>
                    To link a field to an existing component instead of inferring its shape, type{" "}
                    <code>-- component: &lt;name&gt;</code> (combine with required: <code>-- component: address; required</code>
                    ).
                  </li>
                  {baseRequiredFields.length > 0 && (
                    <li>
                      This schema must include these base fields: <code>{baseRequiredFields.join(", ")}</code>.
                    </li>
                  )}
                </ul>
              </div>
              <Editor
                height="60vh"
                defaultLanguage="json"
                value={inputText}
                onChange={(value) => setInputText(value ?? "")}
                options={{ minimap: { enabled: false } }}
              />
            </>
          ) : (
            <div className="rules-tab">
              {fields.length === 0 ? (
                <p className="muted">This schema has no fields yet. Add an example on the Input tab first.</p>
              ) : (
                <>
                  <h4>Required fields</h4>
                  <p className="muted">
                    Fields are optional by default. Add a field here to make it always required. Remove a field to
                    make it optional again. This also updates the <code>-- required</code> comment on the Input tab
                    if the field came from there.
                  </p>
                  <FieldMultiPicker
                    treeNodes={schemaTreeNodes}
                    values={allRequiredFields}
                    addLabel="+ require field"
                    onChange={handleRequiredFieldsChange}
                  />
                  <h4>Component links</h4>
                  <p className="muted">
                    Link a field to an existing component instead of typing{" "}
                    <code>-- component: &lt;name&gt;</code> by hand.
                  </p>
                  <ComponentLinkPicker
                    treeNodes={ownFieldTreeNodes}
                    links={componentLinks}
                    availableComponents={availableComponents}
                    onLink={handleLinkComponent}
                    onUnlink={handleUnlinkComponent}
                  />
                  <h4>Rules</h4>
                  <RuleBuilder rules={rules} fields={fields} treeNodes={schemaTreeNodes} onChange={handleRulesChange} />
                </>
              )}
            </div>
          )}
        </div>

        <div className="editor-split-right">
          <div className="tabs">
            <button className={rightTab === "source" ? "active" : ""} onClick={() => setRightTab("source")}>
              Schema
            </button>
            <button className={rightTab === "examples" ? "active" : ""} onClick={() => setRightTab("examples")}>
              Examples
            </button>
          </div>

          {rightTab === "source" ? (
            <Editor
              height="60vh"
              defaultLanguage="json"
              value={resolved}
              options={{ readOnly: true, minimap: { enabled: false } }}
            />
          ) : (
            <div className="example-tab">
              <div className="example-selector">
                <label>
                  Example:{" "}
                  <select value={exampleSelection} onChange={(e) => setExampleSelection(e.target.value)}>
                    {exampleOptions.map((name) => {
                      const fixture = fixtures.find((f) => f.name === name);
                      const label =
                        name === GENERATED_EXAMPLE_KEY ? "Full (generated)" : name === PRIMARY_EXAMPLE_KEY ? "Primary" : name;
                      return (
                        <option key={name} value={name}>
                          {fixture && !fixture.valid ? `⚠ ${label}` : label}
                        </option>
                      );
                    })}
                  </select>
                </label>
              </div>
              {selectedFixture && !selectedFixture.valid && (
                <div className="panel error">
                  This fixture is stale — it no longer validates against the current schema
                  {selectedFixture.errorSummary && <>: {selectedFixture.errorSummary}</>}. Nothing updates fixtures
                  automatically when the schema (or a component/base it depends on) changes. Click "Refresh
                  Examples" at the top to fill in missing required fields automatically (other kinds of mismatches
                  need a manual fix).
                </div>
              )}
              {exampleError && <div className="panel error">{exampleError}</div>}
              {exampleLoading ? (
                <div className="panel">Loading example...</div>
              ) : (
                <JsonTree nodes={buildExampleTree(exampleData)} defaultExpandedDepth={2} />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
