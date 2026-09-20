import { useEffect, useState } from "react";
import { FamilyList } from "./components/FamilyList";
import { FamilySidebar } from "./components/FamilySidebar";
import { SchemaEditor } from "./components/SchemaEditor";
import { NewSchemaForm } from "./components/NewSchemaForm";
import { ExtractComponentForm } from "./components/ExtractComponentForm";
import { api } from "./api/client";
import type { FamilyDetail } from "./types";

export type Selection =
  | { kind: "base" }
  | { kind: "component"; name: string }
  | { kind: "schema"; name: string }
  | { kind: "newSchema" }
  | { kind: "extractComponent" };

export default function App() {
  const [familyName, setFamilyName] = useState<string | null>(null);
  const [family, setFamily] = useState<FamilyDetail | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!familyName) {
      setFamily(null);
      setSelection(null);
      return;
    }
    api
      .getFamily(familyName)
      .then((detail) => {
        setFamily(detail);
        setSelection({ kind: "base" });
      })
      .catch((err) => setError(err.message));
  }, [familyName]);

  // Re-fetches the family's schema/component lists without touching
  // selection — used after creating a new schema so the sidebar picks it up.
  const refreshFamily = async () => {
    if (!familyName) return;
    const detail = await api.getFamily(familyName);
    setFamily(detail);
  };

  if (!familyName) {
    return <FamilyList onSelect={setFamilyName} />;
  }

  if (error) {
    return <div className="panel error">Failed to load family: {error}</div>;
  }

  if (!family) {
    return <div className="panel">Loading family...</div>;
  }

  return (
    <div className="workspace">
      <FamilySidebar
        family={family}
        selection={selection}
        onSelect={setSelection}
        onBack={() => setFamilyName(null)}
      />
      <main className="main-panel">
        {selection?.kind === "newSchema" ? (
          <NewSchemaForm
            family={family}
            onCreated={async (name) => {
              await refreshFamily();
              setSelection({ kind: "schema", name });
            }}
            onCancel={() => setSelection(null)}
          />
        ) : selection?.kind === "extractComponent" ? (
          <ExtractComponentForm
            family={family}
            onExtracted={async (name) => {
              await refreshFamily();
              setSelection({ kind: "component", name });
            }}
            onCancel={() => setSelection(null)}
          />
        ) : selection ? (
          <SchemaEditor family={family.name} selection={selection} />
        ) : (
          <div className="panel">Select the base config, a component, or a schema from the sidebar.</div>
        )}
      </main>
    </div>
  );
}
