import { useEffect, useState } from "react";
import Editor from "@monaco-editor/react";
import { api } from "../api/client";
import type { Selection } from "../App";

interface Props {
  family: string;
  selection: Selection;
}

type Tab = "source" | "resolved";

export function SchemaEditor({ family, selection }: Props) {
  const [tab, setTab] = useState<Tab>("source");
  const [raw, setRaw] = useState<string>("");
  const [resolved, setResolved] = useState<string>("");
  const [usedBy, setUsedBy] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");

  const isEditable = selection.kind !== "base";

  useEffect(() => {
    setLoading(true);
    setError(null);
    setSaveState("idle");
    setTab("source");

    const load = async () => {
      if (selection.kind === "base") {
        const family_ = await api.getFamily(family);
        void family_; // base has no dedicated GET route yet; show a placeholder
        setRaw("// Base config is locked and defined per-family.\n// Editing UI for base.schema.json is a follow-up iteration.");
        setResolved("");
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

    load()
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [family, selection]);

  const handleSave = async () => {
    if (!isEditable) return;
    setSaveState("saving");
    setError(null);
    try {
      const parsed = JSON.parse(raw);
      if (selection.kind === "component") {
        await api.saveComponent(family, selection.name, parsed);
        const detail = await api.getComponent(family, selection.name);
        setResolved(JSON.stringify(detail.resolved, null, 2));
        setUsedBy(detail.usedBy);
      } else {
        await api.saveSchema(family, selection.name, parsed);
        const detail = await api.getSchema(family, selection.name);
        setResolved(JSON.stringify(detail.resolved, null, 2));
      }
      setSaveState("saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaveState("idle");
    }
  };

  const title = selection.kind === "base" ? "base.schema.json" : selection.name;

  return (
    <div className="editor-pane">
      <div className="editor-toolbar">
        <h3>{title}</h3>
        <div className="tabs">
          <button className={tab === "source" ? "active" : ""} onClick={() => setTab("source")}>
            Source
          </button>
          <button
            className={tab === "resolved" ? "active" : ""}
            onClick={() => setTab("resolved")}
            disabled={selection.kind === "base"}
          >
            Resolved
          </button>
        </div>
        {isEditable && (
          <button className="save-button" onClick={handleSave} disabled={saveState === "saving"}>
            {saveState === "saving" ? "Saving..." : saveState === "saved" ? "Saved ✓" : "Save"}
          </button>
        )}
      </div>

      {selection.kind === "component" && usedBy.length > 0 && (
        <div className="usage-banner">
          Used by (transitively): {usedBy.join(", ")}
        </div>
      )}

      {error && <div className="panel error">{error}</div>}
      {loading ? (
        <div className="panel">Loading...</div>
      ) : (
        <Editor
          height="70vh"
          defaultLanguage="json"
          value={tab === "source" ? raw : resolved}
          onChange={(value) => {
            if (tab === "source" && isEditable) setRaw(value ?? "");
          }}
          options={{ readOnly: tab === "resolved" || !isEditable, minimap: { enabled: false } }}
        />
      )}
    </div>
  );
}
