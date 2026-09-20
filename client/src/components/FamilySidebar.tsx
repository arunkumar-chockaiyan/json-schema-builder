import type { FamilyDetail } from "../types";
import type { Selection } from "../App";

interface Props {
  family: FamilyDetail;
  selection: Selection | null;
  onSelect: (selection: Selection) => void;
  onBack: () => void;
}

export function FamilySidebar({ family, selection, onSelect, onBack }: Props) {
  const isSelected = (s: Selection): boolean => {
    if (!selection || selection.kind !== s.kind) return false;
    if (s.kind === "base") return true;
    return "name" in selection && "name" in s && selection.name === s.name;
  };

  return (
    <nav className="sidebar">
      <button className="link-button" onClick={onBack}>
        ← Families
      </button>
      <h2>{family.name}</h2>

      <div className="tree-section">
        <div className="tree-heading">Base</div>
        <button
          className={`tree-item ${selection?.kind === "base" ? "selected" : ""}`}
          onClick={() => onSelect({ kind: "base" })}
        >
          🔒 base.schema.json
        </button>
      </div>

      <div className="tree-section">
        <div className="tree-heading">Components ({family.components.length})</div>
        {family.components.map((name) => (
          <div className="tree-row" key={name}>
            <button
              className={`tree-item ${isSelected({ kind: "component", name }) ? "selected" : ""}`}
              onClick={() => onSelect({ kind: "component", name })}
            >
              🧩 {name}
            </button>
            <button className="tree-remove-button" disabled title="Not implemented yet">
              🗑
            </button>
          </div>
        ))}
        <button
          className={`tree-item new-item ${selection?.kind === "extractComponent" ? "selected" : ""}`}
          onClick={() => onSelect({ kind: "extractComponent" })}
        >
          + Extract Component
        </button>
      </div>

      <div className="tree-section">
        <div className="tree-heading">Schemas ({family.schemas.length})</div>
        {family.schemas.map((name) => (
          <div className="tree-row" key={name}>
            <button
              className={`tree-item ${isSelected({ kind: "schema", name }) ? "selected" : ""}`}
              onClick={() => onSelect({ kind: "schema", name })}
            >
              📄 {name}
            </button>
            <button className="tree-remove-button" disabled title="Not implemented yet">
              🗑
            </button>
          </div>
        ))}
        <button
          className={`tree-item new-item ${selection?.kind === "newSchema" ? "selected" : ""}`}
          onClick={() => onSelect({ kind: "newSchema" })}
        >
          + New Schema
        </button>
      </div>
    </nav>
  );
}
