import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { FamilySummary } from "../types";

interface Props {
  onSelect: (family: string) => void;
}

export function FamilyList({ onSelect }: Props) {
  const [families, setFamilies] = useState<FamilySummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listFamilies()
      .then((res) => setFamilies(res.families))
      .catch((err) => setError(err.message));
  }, []);

  if (error) return <div className="panel error">Failed to load registry: {error}</div>;
  if (!families) return <div className="panel">Loading registry...</div>;

  return (
    <div className="panel">
      <h1>Registry</h1>
      <p className="muted">Select a family to browse its base config, components, and schemas.</p>
      <ul className="family-list">
        {families.map((f) => (
          <li key={f.name}>
            <button className="family-card" onClick={() => onSelect(f.name)}>
              <span className="family-name">{f.name}</span>
              <span className="muted">{f.description}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
