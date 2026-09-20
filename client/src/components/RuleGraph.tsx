import type { ReactNode } from "react";
import { OPERATOR_LABELS, type Rule } from "../rules";

interface Props {
  rules: Rule[];
  onEdit?: (id: string) => void;
  onDelete?: (id: string) => void;
  editingId?: string | null;
  renderEditor?: (rule: Rule) => ReactNode;
}

// Lightweight, dependency-free visualization scoped only to rule
// participants (not the whole schema tree) — one flow row per rule:
// WHEN field --operator:value--> THEN fields. Plain HTML/CSS, no canvas or
// graphing library; the rule counts this tool targets don't need one. Also
// doubles as the primary Rules list — each row shows edit/delete icons
// (when the corresponding callback is provided) rather than rules being
// permanently editable inline. When a rule is being edited, `renderEditor`
// is rendered directly beneath its row, inside the same bordered container,
// so it's unambiguous which rule the editor belongs to.
export function RuleGraph({ rules, onEdit, onDelete, editingId, renderEditor }: Props) {
  if (rules.length === 0) {
    return <p className="muted">No rules to visualize yet.</p>;
  }

  return (
    <div className="rule-graph">
      {rules.map((rule) => {
        const requiredTargets = [
          ...(rule.then.require ?? []),
          ...(rule.then.constrain ? [rule.then.constrain.field] : []),
        ];
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
                {requiredTargets.length === 0 && forbiddenTargets.length === 0 ? (
                  <span className="muted">(no effect set)</span>
                ) : (
                  <>
                    {requiredTargets.map((t) => (
                      <span className="graph-node graph-node-then" key={`req-${t}`}>
                        {t}
                      </span>
                    ))}
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
