// Shared types for the registry domain model.

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

export class RegistryError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 400,
  ) {
    super(message);
    this.name = "RegistryError";
  }
}
