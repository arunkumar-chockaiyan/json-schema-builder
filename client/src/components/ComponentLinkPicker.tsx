import { useEffect, useState } from "react";
import { FieldPicker } from "./FieldPicker";
import type { TreeNode } from "./JsonTree";

// Lets someone link (or reassign/unlink) a field to an existing component
// without hand-typing the `-- component: <name>` comment directive in the
// Input tab — picks a field from this schema's own raw fields, picks a
// component from the family's list, done.
export function ComponentLinkPicker({
  treeNodes,
  links,
  availableComponents,
  onLink,
  onUnlink,
}: {
  treeNodes: TreeNode[];
  links: Map<string, string>;
  availableComponents: string[];
  onLink: (path: string, componentName: string) => void;
  onUnlink: (path: string) => void;
}) {
  const [newField, setNewField] = useState("");
  const [newComponent, setNewComponent] = useState(availableComponents[0] ?? "");

  // availableComponents loads asynchronously in the parent — pick a default
  // once it arrives if none was set yet (first render can still be empty).
  useEffect(() => {
    if (!newComponent && availableComponents.length > 0) setNewComponent(availableComponents[0]);
  }, [availableComponents, newComponent]);

  const entries = Array.from(links.entries());

  if (availableComponents.length === 0) {
    return <p className="muted">This family has no components yet.</p>;
  }

  return (
    <div className="component-link-picker">
      {entries.length === 0 ? (
        <p className="muted">No fields are linked to a component yet.</p>
      ) : (
        entries.map(([path, componentName]) => (
          <div key={path} className="component-link-row">
            <span className="chip">{path}</span>
            <select value={componentName} onChange={(e) => onLink(path, e.target.value)}>
              {availableComponents.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <button type="button" className="link-button" onClick={() => onUnlink(path)}>
              ✕ unlink
            </button>
          </div>
        ))
      )}

      <div className="component-link-row component-link-add">
        <FieldPicker treeNodes={treeNodes} value={newField} isSelectable={() => true} onChange={setNewField} />
        <select value={newComponent} onChange={(e) => setNewComponent(e.target.value)}>
          {availableComponents.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="add-rule-button"
          disabled={!newField || !newComponent}
          onClick={() => {
            onLink(newField, newComponent);
            setNewField("");
          }}
        >
          + Link
        </button>
      </div>
    </div>
  );
}
