import { useState, type ReactNode } from "react";

export interface TreeNode {
  key: string;
  path: string;
  kind: "object" | "array" | "leaf";
  depth: number;
  type?: string;
  enum?: unknown[];
  description?: string;
  value?: unknown;
  children?: TreeNode[];
}

// Walks a *resolved* schema's `properties` (base merged in, $refs already
// dereferenced) into a tree for browsing/picking. Arrays render a single
// summarizing "items" child rather than per-index, matching how the schema
// itself describes them.
export function buildSchemaTree(properties: Record<string, unknown> | undefined, depth = 0, pathPrefix = ""): TreeNode[] {
  if (!properties) return [];
  return Object.entries(properties).map(([key, raw]) => {
    const schema = (raw ?? {}) as Record<string, unknown>;
    const path = pathPrefix ? `${pathPrefix}.${key}` : key;
    const type = typeof schema.type === "string" ? schema.type : undefined;
    const description = typeof schema.description === "string" ? schema.description : undefined;
    const enumValues = Array.isArray(schema.enum) ? schema.enum : undefined;

    if (type === "object" && schema.properties && typeof schema.properties === "object") {
      return {
        key,
        path,
        kind: "object",
        depth,
        type,
        description,
        children: buildSchemaTree(schema.properties as Record<string, unknown>, depth + 1, path),
      } satisfies TreeNode;
    }

    if (type === "array") {
      const items = schema.items as Record<string, unknown> | undefined;
      const itemChildren =
        items && items.type === "object" && items.properties
          ? buildSchemaTree(items.properties as Record<string, unknown>, depth + 2, `${path}.items`)
          : [];
      return {
        key,
        path,
        kind: "array",
        depth,
        type: `array<${typeof items?.type === "string" ? items.type : "any"}>`,
        description,
        children: [
          {
            key: "items",
            path: `${path}.items`,
            kind: itemChildren.length > 0 ? "object" : "leaf",
            depth: depth + 1,
            type: typeof items?.type === "string" ? items.type : undefined,
            children: itemChildren,
          },
        ],
      } satisfies TreeNode;
    }

    return { key, path, kind: "leaf", depth, type, description, enum: enumValues } satisfies TreeNode;
  });
}

// Walks a plain JS value (a parsed example/test-case JSON document) into the
// same tree shape, for the read-only Example view.
export function buildExampleTree(value: unknown, depth = 0, pathPrefix = "", key = ""): TreeNode[] {
  if (value === null || typeof value !== "object") {
    return [];
  }

  if (Array.isArray(value)) {
    return value.map((item, index) => {
      const path = pathPrefix ? `${pathPrefix}.${index}` : String(index);
      return nodeForExampleValue(String(index), path, depth, item);
    });
  }

  return Object.entries(value as Record<string, unknown>).map(([k, v]) => {
    const path = pathPrefix ? `${pathPrefix}.${k}` : k;
    return nodeForExampleValue(k, path, depth, v);
  });
}

function nodeForExampleValue(key: string, path: string, depth: number, value: unknown): TreeNode {
  if (value !== null && typeof value === "object") {
    const kind = Array.isArray(value) ? "array" : "object";
    return {
      key,
      path,
      kind,
      depth,
      type: kind,
      children: buildExampleTree(value, depth + 1, path),
    };
  }
  return {
    key,
    path,
    kind: "leaf",
    depth,
    type: value === null ? "null" : typeof value,
    value,
  };
}

interface JsonTreeProps {
  nodes: TreeNode[];
  selectable?: boolean;
  isSelectable?: (node: TreeNode) => boolean;
  selectedPaths?: string[];
  onSelect?: (path: string) => void;
  defaultExpandedDepth?: number;
}

export function JsonTree({
  nodes,
  selectable = false,
  isSelectable,
  selectedPaths = [],
  onSelect,
  defaultExpandedDepth = 1,
}: JsonTreeProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const toggle = (path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const renderNode = (node: TreeNode): ReactNode => {
    const isContainer = node.kind === "object" || node.kind === "array";
    // Nodes shallower than defaultExpandedDepth start open; toggling a node
    // flips it away from that default, tracked by presence in `collapsed`
    // (the set name reflects the toggled-away-from-default state, not
    // literally "is collapsed", for nodes that default open).
    const defaultOpen = node.depth < defaultExpandedDepth;
    const open = collapsed.has(node.path) ? !defaultOpen : defaultOpen;

    const canSelect = selectable && (isSelectable ? isSelectable(node) : true);
    const isSelected = selectedPaths.includes(node.path);

    return (
      <div key={node.path} className="json-tree-node">
        <div
          className={`json-tree-row ${canSelect ? "selectable" : ""} ${isSelected ? "selected" : ""}`}
          style={{ paddingLeft: `${node.depth * 16 + 6}px` }}
          onClick={() => {
            if (canSelect && onSelect) onSelect(node.path);
          }}
        >
          {isContainer ? (
            <button
              className="json-tree-caret"
              onClick={(e) => {
                e.stopPropagation();
                toggle(node.path);
              }}
            >
              {open ? "▾" : "▸"}
            </button>
          ) : (
            <span className="json-tree-caret-spacer" />
          )}

          <span className="json-tree-key">{node.key}</span>

          {node.kind === "leaf" && node.value !== undefined && (
            <span className="json-tree-value">{formatValue(node.value)}</span>
          )}
          {node.type && <span className="json-tree-type">{node.type}</span>}
          {node.enum && <span className="json-tree-enum">enum: {node.enum.map(String).join(" | ")}</span>}
          {isContainer && !open && <span className="json-tree-summary">{summarize(node)}</span>}
          {node.description && <span className="json-tree-description">{node.description}</span>}
          {isSelected && <span className="json-tree-check">✓</span>}
          {selectable && isContainer && !canSelect && (
            <span className="json-tree-hint" title="Nested field selection coming soon">
              not selectable yet
            </span>
          )}
        </div>
        {isContainer && open && node.children && (
          <div className="json-tree-children">{node.children.map(renderNode)}</div>
        )}
      </div>
    );
  };

  if (nodes.length === 0) {
    return <p className="muted">Nothing to show.</p>;
  }

  return <div className="json-tree">{nodes.map(renderNode)}</div>;
}

function summarize(node: TreeNode): string {
  const count = node.children?.length ?? 0;
  return node.kind === "array" ? `[${count === 1 ? "items" : `${count} entries`}]` : `{${count} field${count === 1 ? "" : "s"}}`;
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return `"${value}"`;
  return String(value);
}
