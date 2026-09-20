import { useState } from "react";
import { JsonTree, type TreeNode } from "./JsonTree";

// A single-select field picker: a button that shows the current selection.
// The button toggles an inline JsonTree popover. Click a node to select it
// and close the popover. `isSelectable` decides which nodes can be picked.
// For example, a rule field is restricted to the top level, while component
// extraction allows any object node at any depth. The full nested,
// component-derived structure is always visible for browsing, regardless of
// what can be picked.
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
