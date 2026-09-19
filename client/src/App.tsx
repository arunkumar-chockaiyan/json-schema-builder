import { useEffect, useState } from "react";
import { FamilyList } from "./components/FamilyList";
import { FamilySidebar } from "./components/FamilySidebar";
import { SchemaEditor } from "./components/SchemaEditor";
import { api } from "./api/client";
import type { FamilyDetail } from "./types";

export type Selection = { kind: "base" } | { kind: "component"; name: string } | { kind: "schema"; name: string };

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
        setSelection(null);
      })
      .catch((err) => setError(err.message));
  }, [familyName]);

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
        {selection ? (
          <SchemaEditor family={family.name} selection={selection} />
        ) : (
          <div className="panel">Select the base config, a component, or a schema from the sidebar.</div>
        )}
      </main>
    </div>
  );
}
