import { useEffect, useState } from "react";
import { OPERATOR_LABELS, newRuleId, type Rule, type RuleOperator } from "../rules";
import { JsonTree, type TreeNode } from "./JsonTree";
import { FieldPicker } from "./FieldPicker";
import { RuleGraph } from "./RuleGraph";

export interface FieldInfo {
  name: string;
  type?: string;
  enum?: unknown[];
}

interface Props {
  rules: Rule[];
  fields: FieldInfo[];
  treeNodes: TreeNode[];
  onChange: (rules: Rule[]) => void;
}

// Any field at any depth can be a rule target (the compiler supports nested
// dot-paths, wrapping properties/required through each ancestor) — just not
// the field the rule's own WHEN condition is already keyed on.
function fieldSelectable(excludeField?: string) {
  return (n: TreeNode) => n.path !== excludeField;
}

// Multi-select field picker: chips for each selected path + an "add field"
// trigger that opens the same inline tree; clicking a selected node again
// removes it.
export function FieldMultiPicker({
  treeNodes,
  values,
  onChange,
  excludeField,
  addLabel,
}: {
  treeNodes: TreeNode[];
  values: string[];
  onChange: (values: string[]) => void;
  excludeField?: string;
  addLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const toggle = (path: string) => {
    onChange(values.includes(path) ? values.filter((v) => v !== path) : [...values, path]);
  };
  return (
    <div className="field-multi-picker">
      <div className="chip-list">
        {values.map((v) => (
          <span key={v} className="chip">
            {v}
            <button type="button" className="chip-remove" onClick={() => toggle(v)}>
              ×
            </button>
          </span>
        ))}
        <button type="button" className="field-picker-trigger" onClick={() => setOpen((o) => !o)}>
          {addLabel} {open ? "▴" : "▾"}
        </button>
      </div>
      {open && (
        <div className="field-picker-tree">
          <JsonTree
            nodes={treeNodes}
            selectable
            isSelectable={fieldSelectable(excludeField)}
            selectedPaths={values}
            onSelect={toggle}
          />
        </div>
      )}
    </div>
  );
}

const OPERATORS = Object.keys(OPERATOR_LABELS) as RuleOperator[];

function fieldInfo(fields: FieldInfo[], name: string): FieldInfo | undefined {
  return fields.find((f) => f.name === name);
}

function needsValue(operator: RuleOperator): boolean {
  return operator !== "present" && operator !== "absent";
}

function isListOperator(operator: RuleOperator): boolean {
  return operator === "oneOf" || operator === "noneOf";
}

// Renders the WHEN value input, adapting to the target field's declared type.
function ValueInput({
  field,
  operator,
  value,
  onChange,
}: {
  field: FieldInfo | undefined;
  operator: RuleOperator;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  if (!needsValue(operator)) return null;

  if (isListOperator(operator)) {
    const listValue = Array.isArray(value) ? (value as unknown[]).join(", ") : "";
    return (
      <input
        type="text"
        placeholder="value1, value2, ..."
        value={listValue}
        onChange={(e) =>
          onChange(
            e.target.value
              .split(",")
              .map((v) => v.trim())
              .filter((v) => v.length > 0),
          )
        }
      />
    );
  }

  if (field?.enum) {
    return (
      <select value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)}>
        <option value="" disabled>
          choose value
        </option>
        {field.enum.map((v) => (
          <option key={String(v)} value={String(v)}>
            {String(v)}
          </option>
        ))}
      </select>
    );
  }

  if (field?.type === "boolean") {
    return (
      <select
        value={value === true ? "true" : value === false ? "false" : ""}
        onChange={(e) => onChange(e.target.value === "true")}
      >
        <option value="" disabled>
          choose value
        </option>
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  }

  if (field?.type === "number" || field?.type === "integer") {
    return (
      <input
        type="number"
        value={typeof value === "number" ? value : ""}
        onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
      />
    );
  }

  return (
    <input
      type="text"
      value={typeof value === "string" ? value : ""}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

// The full WHEN/THEN editor for a single rule — only ever rendered for the
// one rule currently being added or edited, not for the whole list at once.
function RuleEditorCard({
  rule,
  fields,
  treeNodes,
  onChange,
  onDone,
  onCancel,
}: {
  rule: Rule;
  fields: FieldInfo[];
  treeNodes: TreeNode[];
  onChange: (updater: (rule: Rule) => Rule) => void;
  onDone: () => void;
  onCancel: () => void;
}) {
  const whenField = fieldInfo(fields, rule.when.field);
  // Decoupled from rule.then.constrain.enum on purpose: that array is
  // trimmed/filtered on every change (dropping empty trailing entries), so
  // binding the input's value straight to enum.join(", ") snaps back and
  // erases whatever's being typed the moment you type a trailing comma —
  // you'd never be able to start a second value. Local text state tracks
  // exactly what's typed; the derived enum array still updates live.
  const [constrainText, setConstrainText] = useState(() => rule.then.constrain?.enum.join(", ") ?? "");

  useEffect(() => {
    setConstrainText(rule.then.constrain?.enum.join(", ") ?? "");
    // Only re-sync when switching to a different rule — not on every
    // keystroke's derived-array update, which would fight the local state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rule.id]);

  return (
    <div className="rule-card rule-card-editing">
      <div className="rule-row">
        <span className="rule-label">WHEN</span>
        <FieldPicker
          treeNodes={treeNodes}
          value={rule.when.field}
          isSelectable={fieldSelectable()}
          onChange={(field) => onChange((r) => ({ ...r, when: { ...r.when, field, value: "" } }))}
        />
        <select
          value={rule.when.operator}
          onChange={(e) =>
            onChange((r) => ({
              ...r,
              when: { ...r.when, operator: e.target.value as RuleOperator, value: undefined },
            }))
          }
        >
          {OPERATORS.map((op) => (
            <option key={op} value={op}>
              {OPERATOR_LABELS[op]}
            </option>
          ))}
        </select>
        <ValueInput
          field={whenField}
          operator={rule.when.operator}
          value={rule.when.value}
          onChange={(value) => onChange((r) => ({ ...r, when: { ...r.when, value } }))}
        />
      </div>

      <div className="rule-row">
        <span className="rule-label">THEN require</span>
        <FieldMultiPicker
          treeNodes={treeNodes}
          values={rule.then.require ?? []}
          excludeField={rule.when.field}
          addLabel="+ add field"
          onChange={(next) => onChange((r) => ({ ...r, then: { ...r.then, require: next } }))}
        />
      </div>

      <div className="rule-row">
        <span className="rule-label">THEN forbid</span>
        <FieldMultiPicker
          treeNodes={treeNodes}
          values={rule.then.forbid ?? []}
          excludeField={rule.when.field}
          addLabel="+ add field"
          onChange={(next) => onChange((r) => ({ ...r, then: { ...r.then, forbid: next } }))}
        />
      </div>

      <div className="rule-row">
        <label className="checkbox-item">
          <input
            type="checkbox"
            checked={!!rule.then.constrain}
            onChange={(e) => {
              const checked = e.target.checked;
              onChange((r) => ({
                ...r,
                then: {
                  ...r.then,
                  constrain: checked
                    ? { field: fields.find((f) => f.name !== r.when.field)?.name ?? "", enum: [] }
                    : undefined,
                },
              }));
              if (checked) setConstrainText("");
            }}
          />
          also restrict a field to specific values
        </label>
        {rule.then.constrain && (
          <>
            <FieldPicker
              treeNodes={treeNodes}
              value={rule.then.constrain.field}
              isSelectable={fieldSelectable(rule.when.field)}
              onChange={(field) =>
                onChange((r) => ({
                  ...r,
                  then: { ...r.then, constrain: { field, enum: r.then.constrain?.enum ?? [] } },
                }))
              }
            />
            <input
              type="text"
              placeholder="allowed value1, value2, ..."
              value={constrainText}
              onChange={(e) => {
                const text = e.target.value;
                setConstrainText(text);
                onChange((r) => ({
                  ...r,
                  then: {
                    ...r.then,
                    constrain: {
                      field: r.then.constrain?.field ?? "",
                      enum: text
                        .split(",")
                        .map((v) => v.trim())
                        .filter((v) => v.length > 0),
                    },
                  },
                }));
              }}
            />
          </>
        )}
      </div>

      <div className="rule-row rule-editor-actions">
        <button type="button" className="link-button" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="save-button" onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  );
}

export function RuleBuilder({ rules, fields, treeNodes, onChange }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  // Snapshot of the rule as it was when editing began — null means "this is
  // a brand-new rule with no prior state," so Cancel deletes it instead of
  // trying to restore something that never existed. Otherwise Cancel
  // restores the rule to this snapshot, discarding whatever was typed.
  const [editingSnapshot, setEditingSnapshot] = useState<Rule | null>(null);
  const [editingIsNew, setEditingIsNew] = useState(false);

  const updateRule = (id: string, updater: (rule: Rule) => Rule) => {
    onChange(rules.map((r) => (r.id === id ? updater(r) : r)));
  };

  const closeEditor = () => {
    setEditingId(null);
    setEditingSnapshot(null);
    setEditingIsNew(false);
  };

  const startEditing = (id: string) => {
    const rule = rules.find((r) => r.id === id);
    if (!rule) return;
    setEditingId(id);
    setEditingSnapshot(JSON.parse(JSON.stringify(rule)));
    setEditingIsNew(false);
  };

  const addRule = () => {
    const first = fields[0]?.name ?? "";
    const rule: Rule = {
      id: newRuleId(),
      when: { field: first, operator: "equals", value: "" },
      then: { require: [] },
    };
    onChange([...rules, rule]);
    setEditingId(rule.id);
    setEditingSnapshot(null);
    setEditingIsNew(true);
  };

  const removeRule = (id: string) => {
    onChange(rules.filter((r) => r.id !== id));
    if (editingId === id) closeEditor();
  };

  const cancelEditing = () => {
    if (!editingId) return;
    if (editingIsNew) {
      onChange(rules.filter((r) => r.id !== editingId));
    } else if (editingSnapshot) {
      onChange(rules.map((r) => (r.id === editingId ? editingSnapshot : r)));
    }
    closeEditor();
  };

  return (
    <div className="rule-builder">
      <RuleGraph
        rules={rules}
        onEdit={startEditing}
        onDelete={removeRule}
        editingId={editingId}
        renderEditor={(rule) => (
          <RuleEditorCard
            rule={rule}
            fields={fields}
            treeNodes={treeNodes}
            onChange={(updater) => updateRule(rule.id, updater)}
            onDone={closeEditor}
            onCancel={cancelEditing}
          />
        )}
      />

      <button className="add-rule-button" onClick={addRule} disabled={fields.length === 0}>
        + Add rule
      </button>
    </div>
  );
}
