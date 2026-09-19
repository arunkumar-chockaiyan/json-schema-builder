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

  getSchema: (family: string, schema: string) =>
    request<RawAndResolved>(`/families/${family}/schemas/${schema}`),

  saveSchema: (family: string, schema: string, content: unknown) =>
    request<void>(`/families/${family}/schemas/${schema}`, {
      method: "PUT",
      body: JSON.stringify(content),
    }),

  getComponent: (family: string, component: string) =>
    request<ComponentDetail>(`/families/${family}/components/${component}`),

  saveComponent: (family: string, component: string, content: unknown) =>
    request<void>(`/families/${family}/components/${component}`, {
      method: "PUT",
      body: JSON.stringify(content),
    }),
};
