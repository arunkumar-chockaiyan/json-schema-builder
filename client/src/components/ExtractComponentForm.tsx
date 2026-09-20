import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { FamilyDetail } from "../types";
import { buildSchemaTree, type TreeNode } from "./JsonTree";
import { FieldPicker } from "./FieldPicker";

interface Props {
  family: FamilyDetail;
  onExtracted: (name: string) => void;
  onCancel: () => void;
}

const SAFE_NAME = /^[a-zA-Z0-9_-]+$/;
const BASE_SOURCE = "__base__";

export function ExtractComponentForm({ family, onExtracted, onCancel }: Props) {
  const [componentName, setComponentName] = useState("");
  const [sourceKey, setSourceKey] = useState<string>(BASE_SOURCE);
  const [treeNodes, setTreeNodes] = useState<TreeNode[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [extracting, setExtracting] = useState(false);

  useEffect(() => {
    setSelectedPath(null);
    setSourceLoading(true);
    setError(null);
    const fetcher =
      sourceKey === BASE_SOURCE ? api.getBase(family.name) : api.getSchema(family.name, sourceKey);
    fetcher
      .then((detail) => {
        const resolved = detail.resolved as Record<string, unknown>;
        setTreeNodes(buildSchemaTree(resolved.properties as Record<string, unknown> | undefined));
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setSourceLoading(false));
  }, [family.name, sourceKey]);

  const validateName = (): string | null => {
    const trimmed = componentName.trim();
    if (!trimmed) return "Component name is required.";
    if (!SAFE_NAME.test(trimmed)) return "Use only letters, digits, hyphens, and underscores.";
    if (family.components.includes(trimmed)) return `A component named "${trimmed}" already exists in this family.`;
    return null;
  };

  const handleExtract = async () => {
    const nameError = validateName();
    if (nameError) {
      setError(nameError);
      return;
    }
    if (!selectedPath) {
      setError("Pick a field to extract first.");
      return;
    }

    setExtracting(true);
    setError(null);
    try {
      const trimmed = componentName.trim();
      await api.extractComponent(family.name, {
        sourceType: sourceKey === BASE_SOURCE ? "base" : "schema",
        sourceName: sourceKey === BASE_SOURCE ? undefined : sourceKey,
        path: selectedPath.split("."),
        componentName: trimmed,
      });
      onExtracted(trimmed);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setExtracting(false);
    }
  };

  return (
    <div className="editor-pane">
      <div className="editor-toolbar">
        <h3>Extract Component</h3>
        <button className="link-button" onClick={onCancel}>
          cancel
        </button>
        <button className="save-button" onClick={handleExtract} disabled={extracting}>
          {extracting ? "Extracting..." : "Extract"}
        </button>
      </div>

      <div className="new-schema-form">
        <label className="new-schema-name">
          New component name
          <input
            type="text"
            placeholder="e.g. shippingInfo"
            value={componentName}
            onChange={(e) => setComponentName(e.target.value)}
          />
        </label>

        <label className="new-schema-name">
          Extract from
          <select value={sourceKey} onChange={(e) => setSourceKey(e.target.value)}>
            <option value={BASE_SOURCE}>Base</option>
            {family.schemas.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>

        <p className="muted split-hint">
          Pick an object field to pull out into its own reusable component. A nested field is supported, even
          one already inside another component. The tool finds the correct file to patch automatically.
        </p>

        {error && <div className="panel error">{error}</div>}

        {sourceLoading ? (
          <div className="panel">Loading source...</div>
        ) : (
          <FieldPicker
            treeNodes={treeNodes}
            value={selectedPath ?? ""}
            isSelectable={(n) => n.kind === "object"}
            onChange={setSelectedPath}
            placeholder="choose a field to extract"
          />
        )}
      </div>
    </div>
  );
}
