import { useEffect, useState } from "react";
import Editor from "@monaco-editor/react";
import { api } from "../api/client";
import type { FamilyDetail } from "../types";

interface Props {
  family: FamilyDetail;
  onCreated: (name: string) => void;
  onCancel: () => void;
}

const SAFE_NAME = /^[a-zA-Z0-9_-]+$/;
const DEFAULT_EXAMPLE = "{\n  \n}";

export function NewSchemaForm({ family, onCreated, onCancel }: Props) {
  const [name, setName] = useState("");
  const [inputText, setInputText] = useState(DEFAULT_EXAMPLE);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [baseRequiredFields, setBaseRequiredFields] = useState<string[]>([]);

  // Seed the editor with a skeleton containing the base's required fields,
  // so it's obvious from the start what the "minimum" is — only if the user
  // hasn't started typing yet.
  useEffect(() => {
    api
      .getBase(family.name)
      .then((detail) => {
        const req = (detail.raw as Record<string, unknown>)?.required;
        const fields = Array.isArray(req) ? (req as string[]) : [];
        setBaseRequiredFields(fields);
        if (inputText === DEFAULT_EXAMPLE && fields.length > 0) {
          const skeleton = fields.map((f) => `  "${f}": ""`).join(",\n");
          setInputText(`{\n${skeleton}\n  -- add your own fields below\n}`);
        }
      })
      .catch(() => setBaseRequiredFields([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [family.name]);

  const validateName = (): string | null => {
    const trimmed = name.trim();
    if (!trimmed) return "Schema name is required.";
    if (!SAFE_NAME.test(trimmed)) return "Use only letters, digits, hyphens, and underscores.";
    if (family.schemas.includes(trimmed)) return `A schema named "${trimmed}" already exists in this family.`;
    return null;
  };

  const handleCreate = async () => {
    const nameError = validateName();
    if (nameError) {
      setError(nameError);
      return;
    }

    setCreating(true);
    setError(null);
    try {
      const trimmed = name.trim();
      await api.saveSchema(family.name, trimmed, {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        title: `${family.name}.${trimmed}`,
        type: "object",
        "x-example-source": inputText,
      });
      onCreated(trimmed);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="editor-pane">
      <div className="editor-toolbar">
        <h3>New Schema</h3>
        <button className="link-button" onClick={onCancel}>
          cancel
        </button>
        <button className="save-button" onClick={handleCreate} disabled={creating}>
          {creating ? "Creating..." : "Create"}
        </button>
      </div>

      <div className="new-schema-form">
        <label className="new-schema-name">
          Name
          <input
            type="text"
            placeholder="e.g. invoice"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>

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
              To create an enum, type values separated by commas, for example <code>"card,check"</code>. The first
              value becomes the example value.
            </li>
            <li>You can add rules and component links after you create the schema.</li>
            {baseRequiredFields.length > 0 && (
              <li>
                This schema must include these base fields: <code>{baseRequiredFields.join(", ")}</code>.
              </li>
            )}
          </ul>
        </div>

        {error && <div className="panel error">{error}</div>}

        <Editor
          height="55vh"
          defaultLanguage="json"
          value={inputText}
          onChange={(value) => setInputText(value ?? "")}
          options={{ minimap: { enabled: false } }}
        />
      </div>
    </div>
  );
}
