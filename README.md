# JSON Schema Builder

A local-first tool for building and managing a registry of JSON Schemas, organized into isolated **families** (e.g. `commerce`, `billing`). Each family has a locked **base config** that every schema in it inherits, a set of reusable **components**, and any number of **schemas** — authored by writing an example instance, not by hand-writing JSON Schema.

No database, no hosting — the registry is a folder of JSON files, versioned with git. There is no semver; git history is the only version record.

## Why

Most JSON Schema tooling assumes you already think in `properties`/`required`/`$ref`. This tool inverts that: you paste or type a representative example, optionally annotate a few fields with lightweight `--` comments, and the tool derives the schema. Conditional logic (`if`/`then`), shared sub-shapes, and locked cross-schema fields are all built as guided UI flows on top of that, not raw JSON editing.

## Features

- **Families** — isolated bounded contexts; nothing is shared or referenced across family boundaries.
- **Base config** — a locked set of fields (e.g. `id`, `createdAt`, `tenantId`) merged into every schema in a family. Editable, but locked by default in the UI as a safeguard, since a change affects every schema at once. A base field can also be marked an "open extension point" (a schema-varying generic object, e.g. `details`), letting individual schemas layer their own typed sub-fields on top of it.
- **Components** — reusable, nestable schema fragments (e.g. `address`, `contact`), referenced via `$ref`. Existing inline shapes can be pulled out into a new component with **Extract Component**, which finds and patches the correct owning file even when the shape is nested inside another component.
- **Example-driven schema authoring** — type an annotated JSON example; the tool derives `properties`/`required` from it. Fields are optional by default; mark one required with a `-- required` comment, or use the explicit "Required fields" picker in the Constraints tab. A value like `"card,check"` is read as declaring an enum.
- **Constraints** — conditional rules (`WHEN field = X THEN require/forbid/restrict other fields`, including nested paths like `contact.email`), compiled to standard JSON Schema `allOf`/`if`/`then`, plus the unconditional required-fields list.
- **Examples** — every schema shows a synthesized "Full" example (every field populated, nothing persisted), the current annotated example ("Primary"), and any hand-authored fixture files.
- **Fixture staleness detection & sync** — fixtures are static files; nothing updates them automatically when a schema or a component/base it depends on changes. The tool validates each fixture against the *current* resolved schema and flags anything now invalid. A "Sync fixtures with schema" action fixes missing-required-field breaks and fills in newly-added optional fields, without ever touching existing values.

## Getting started

```bash
npm install
npm run dev
```

Then open `http://localhost:5173`. The API server runs on `:3001`; the Vite dev server proxies `/api` to it.

## Project structure

```
/registry                      # the actual schema data — a folder per family
  registry.json                 # family -> description
  /<family>
    family.json
    base.schema.json            # locked base config for this family
    /components/*.schema.json
    /schemas/*.schema.json
    /tests/<schema>/*.json      # hand-authored fixtures

/server                        # Fastify API (Node/TypeScript)
  src/lib/                      # resolver, rule compiler, example derivation, extraction, fixture validation/repair
  src/routes/                   # one file per resource

/client                        # React + Vite frontend
  src/components/                # schema editor, rule builder, field pickers, tree viewer
```

## Tech stack

- **Backend**: Node.js, TypeScript, Fastify, ajv
- **Frontend**: React, TypeScript, Vite, Monaco Editor
- **Storage**: flat JSON files under `/registry`, versioned with git

## License

MIT — see [LICENSE](LICENSE).
