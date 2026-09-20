import { useState } from "react";
import { JsonTree, type TreeNode } from "./JsonTree";

// Single-select field picker: a button showing the current selection, which
// toggles an inline JsonTree popover — click a node to select it and close.
// `isSelectable` decides which nodes can be picked (e.g. rule fields are
// restricted to top-level; component extraction allows any object node at
// any depth) — the full nested/component-derived structure is always
// visible for browsing regardless.
export function FieldPicker({
  treeNodes,
  value,
  onChange,
  isSelectable,
  placeholder = "choose field",
}: {
  treeNodes: TreeNode[];
  value: string;
  onChange: (path: string) => void;
  isSelectable: (node: TreeNode) => boolean;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="field-picker">
      <button type="button" className="field-picker-trigger" onClick={() => setOpen((o) => !o)}>
        {value || placeholder} {open ? "▴" : "▾"}
      </button>
      {open && (
        <div className="field-picker-tree">
          <JsonTree
            nodes={treeNodes}
            selectable
            isSelectable={isSelectable}
            selectedPaths={value ? [value] : []}
            onSelect={(path) => {
              onChange(path);
              setOpen(false);
            }}
          />
        </div>
      )}
    </div>
  );
}
