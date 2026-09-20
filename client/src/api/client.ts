import type { ComponentDetail, FamilyDetail, FamilySummary, RawAndResolved } from "../types";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  listFamilies: () => request<{ families: FamilySummary[] }>("/registry"),

  getFamily: (family: string) => request<FamilyDetail>(`/families/${family}`),

  getBase: (family: string) => request<RawAndResolved>(`/families/${family}/base`),

  getBaseExample: (family: string) => request<unknown>(`/families/${family}/base/example`),

  saveBase: (family: string, content: unknown) =>
    request<void>(`/families/${family}/base`, {
      method: "PUT",
      body: JSON.stringify(content),
    }),

  getSchema: (family: string, schema: string) =>
    request<RawAndResolved>(`/families/${family}/schemas/${schema}`),

  saveSchema: (family: string, schema: string, content: unknown) =>
    request<void>(`/families/${family}/schemas/${schema}`, {
      method: "PUT",
      body: JSON.stringify(content),
    }),

  getComponent: (family: string, component: string) =>
    request<ComponentDetail>(`/families/${family}/components/${component}`),

  getComponentExample: (family: string, component: string) =>
    request<unknown>(`/families/${family}/components/${component}/example`),

  saveComponent: (family: string, component: string, content: unknown) =>
    request<void>(`/families/${family}/components/${component}`, {
      method: "PUT",
      body: JSON.stringify(content),
    }),

  listExamples: (family: string, schema: string) =>
    request<{ examples: { name: string; valid: boolean; errorSummary?: string }[] }>(
      `/families/${family}/schemas/${schema}/examples`,
    ),

  getExample: (family: string, schema: string, name: string) =>
    request<unknown>(`/families/${family}/schemas/${schema}/examples/${name}`),

  getGeneratedExample: (family: string, schema: string) =>
    request<unknown>(`/families/${family}/schemas/${schema}/examples/_generated`),

  getPrimaryExample: (family: string, schema: string) =>
    request<unknown>(`/families/${family}/schemas/${schema}/examples/_primary`),

  repairFixtures: (family: string, schema: string) =>
    request<{
      repaired: {
        name: string;
        valid: boolean;
        repairedFields: string[];
        addedOptionalFields: string[];
        remainingErrors?: string[];
      }[];
    }>(`/families/${family}/schemas/${schema}/examples/repair`, { method: "POST" }),

  extractComponent: (
    family: string,
    body: { sourceType: "base" | "schema"; sourceName?: string; path: string[]; componentName: string },
  ) =>
    request<void>(`/families/${family}/extract-component`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
};
