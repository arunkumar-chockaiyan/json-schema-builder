import { useEffect, useMemo, useState } from "react";
import Editor from "@monaco-editor/react";
import { api } from "../api/client";
import type { Selection } from "../App";
import { RuleBuilder, FieldMultiPicker, type FieldInfo } from "./RuleBuilder";
import { JsonTree, buildExampleTree, buildSchemaTree } from "./JsonTree";
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
  const rules = useMemo(
    () => (Array.isArray(rawObj?.["x-rules"]) ? (rawObj!["x-rules"] as Rule[]) : []),
    [rawObj],
  );
  const requiredFields = useMemo(
    () => (Array.isArray(rawObj?.["x-required-fields"]) ? (rawObj!["x-required-fields"] as string[]) : []),
    [rawObj],
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

  const handleRequiredFieldsChange = (nextRequired: string[]) => {
    if (!rawObj) return;
    const nextRaw = { ...rawObj, "x-required-fields": nextRequired };
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
        <button className="save-button" onClick={handleTwoPaneSave} disabled={saveState === "saving"}>
          {saveState === "saving" ? "Saving..." : saveState === "saved" ? "Saved ✓" : leftTab === "input" ? "Apply" : "Save"}
        </button>
      </div>

      <div className="editor-split">
        <div className="editor-split-left">
          <div className="tabs">
            <button className={leftTab === "input" ? "active" : ""} onClick={() => setLeftTab("input")}>
              Input
            </button>
            <button className={leftTab === "rules" ? "active" : ""} onClick={() => setLeftTab("rules")}>
              Constraints {(rules.length > 0 || requiredFields.length > 0) && `(${rules.length + requiredFields.length})`}
            </button>
          </div>

          {leftTab === "input" ? (
            <>
              <p className="muted split-hint">
                Enter an example instance. Add <code>-- a comment</code> after (or above) a field to set its
                description. Fields are optional by default — add <code>-- required</code> (or{" "}
                <code>-- required; description</code>) to make one required. A comma-separated value like{" "}
                <code>"card,check"</code> becomes an enum of those values (the first is used as this example's
                value).
                {baseRequiredFields.length > 0 && (
                  <>
                    {" "}
                    Must include the base's minimum fields: <code>{baseRequiredFields.join(", ")}</code>.
                  </>
                )}
              </p>
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
                <p className="muted">This schema has no properties yet — enter an example on the Input tab first.</p>
              ) : (
                <>
                  <h4>Required fields</h4>
                  <p className="muted">
                    Fields are optional by default. Add fields here to require them unconditionally, independent of
                    the <code>-- required</code> comment directive on the Input tab — useful for base-inherited or
                    component-nested fields the example doesn't spell out directly.
                  </p>
                  <FieldMultiPicker
                    treeNodes={schemaTreeNodes}
                    values={requiredFields}
                    addLabel="+ require field"
                    onChange={handleRequiredFieldsChange}
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
                {fixtures.length > 0 && (
                  <button className="repair-button" onClick={handleRepairFixtures} disabled={repairing}>
                    {repairing ? "Syncing..." : "Sync fixtures with schema"}
                  </button>
                )}
              </div>
              {repairSummary && <p className="muted">{repairSummary}</p>}
              {selectedFixture && !selectedFixture.valid && (
                <div className="panel error">
                  This fixture is stale — it no longer validates against the current schema
                  {selectedFixture.errorSummary && <>: {selectedFixture.errorSummary}</>}. Nothing updates fixtures
                  automatically when the schema (or a component/base it depends on) changes. Click "Sync fixtures
                  with schema" to fill in missing required fields automatically (other kinds of mismatches need a
                  manual fix).
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
