import type { ReactNode } from "react";
import { OPERATOR_LABELS, type Rule } from "../rules";

interface Props {
  rules: Rule[];
  onEdit?: (id: string) => void;
  onDelete?: (id: string) => void;
  editingId?: string | null;
  renderEditor?: (rule: Rule) => ReactNode;
}

const MAX_CONSTRAIN_LABEL_LENGTH = 24;

// Joins constrain values for display. Truncates with an ellipsis once the
// joined text passes a sensible length. This stops one rule's badge from
// stretching the whole row.
function formatConstrainValues(values: unknown[]): string {
  const joined = values.map(String).join(", ");
  return joined.length > MAX_CONSTRAIN_LABEL_LENGTH ? `${joined.slice(0, MAX_CONSTRAIN_LABEL_LENGTH)}…` : joined;
}

// A lightweight visualization with no extra dependencies. It shows only the
// fields a rule touches, not the whole schema tree. One flow row per rule:
// WHEN field --operator:value--> THEN fields. Plain HTML and CSS, with no
// canvas or graphing library. The number of rules this tool targets does
// not need one.
//
// This component also doubles as the primary rule list. Each row shows
// edit and delete icons, when the matching callback is provided, instead of
// making rules permanently editable inline. When a rule is being edited,
// `renderEditor` renders directly beneath its row, inside the same
// bordered container. This makes it unambiguous which rule the editor
// belongs to.
export function RuleGraph({ rules, onEdit, onDelete, editingId, renderEditor }: Props) {
  if (rules.length === 0) {
    return <p className="muted">No rules to visualize yet.</p>;
  }

  return (
    <div className="rule-graph">
      {rules.map((rule) => {
        const requiredTargets = rule.then.require ?? [];
        const constrain = rule.then.constrain;
        const forbiddenTargets = rule.then.forbid ?? [];
        const valueLabel = Array.isArray(rule.when.value)
          ? rule.when.value.join(", ")
          : rule.when.value !== undefined && rule.when.value !== ""
            ? String(rule.when.value)
            : "";
        const isEditing = editingId === rule.id;

        return (
          <div className={`rule-graph-item ${isEditing ? "editing" : ""}`} key={rule.id}>
            <div className="rule-graph-row">
              <span className="graph-node graph-node-when">{rule.when.field}</span>
              <span className="graph-edge">
                {OPERATOR_LABELS[rule.when.operator]}
                {valueLabel && <> "{valueLabel}"</>} →
              </span>
              <div className="graph-node-group">
                {requiredTargets.length === 0 && forbiddenTargets.length === 0 && !constrain ? (
                  <span className="muted">(no effect set)</span>
                ) : (
                  <>
                    {requiredTargets.map((t) => (
                      <span className="graph-node graph-node-then" key={`req-${t}`}>
                        {t}
                      </span>
                    ))}
                    {constrain && (
                      <span
                        className="graph-node graph-node-then"
                        key={`constrain-${constrain.field}`}
                        title={constrain.enum.map(String).join(", ")}
                      >
                        {constrain.field} [{formatConstrainValues(constrain.enum)}]
                      </span>
                    )}
                    {forbiddenTargets.map((t) => (
                      <span className="graph-node graph-node-forbid" key={`forbid-${t}`}>
                        ⛔ {t}
                      </span>
                    ))}
                  </>
                )}
              </div>
              <div className="rule-row-actions">
                {onEdit && (
                  <button
                    type="button"
                    className="rule-icon-button"
                    onClick={() => onEdit(rule.id)}
                    title="Edit rule"
                    aria-label="Edit rule"
                  >
                    ✎
                  </button>
                )}
                {onDelete && (
                  <button
                    type="button"
                    className="rule-icon-button rule-icon-danger"
                    onClick={() => onDelete(rule.id)}
                    title="Delete rule"
                    aria-label="Delete rule"
                  >
                    🗑
                  </button>
                )}
              </div>
            </div>
            {isEditing && renderEditor && renderEditor(rule)}
          </div>
        );
      })}
    </div>
  );
}
