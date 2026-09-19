export interface FamilySummary {
  name: string;
  description: string;
}

export interface FamilyDetail extends FamilySummary {
  components: string[];
  schemas: string[];
}

export interface RawAndResolved {
  raw: unknown;
  resolved: unknown;
}

export interface ComponentDetail extends RawAndResolved {
  usedBy: string[];
}
