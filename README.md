# JSON Schema Builder

A local-first tool for building and managing JSON Schemas. Schemas are organized into isolated **families**, for example `commerce` or `billing`. Each family has a locked **base config**. Every schema in the family inherits the base config. Each family also has reusable **components** and any number of **schemas**. You author a schema by writing an example instance. You do not hand-write JSON Schema.

The registry is a folder of JSON files. There is no database and no hosting. Git tracks all changes. There is no separate version number. Git history is the only version record.

## Why

Most JSON Schema tools assume you already think in `properties`, `required`, and `$ref`. This tool works the other way. You paste or type a real example. You can add lightweight `--` comments to a few fields. The tool derives the schema from your example. Conditional logic (`if`/`then`), shared sub-shapes, and locked cross-schema fields are all guided UI flows. You never edit raw JSON Schema by hand.

## Features

- **Families** — Each family is an isolated context. Nothing is shared between families.
- **Base config** — A locked set of fields, for example `id`, `createdAt`, `tenantId`. The base config merges into every schema in the family. You can edit the base config, but the UI locks it by default. This is a safeguard: a change to base affects every schema at once. A base field can also be an "open extension point." This is a generic object field, for example `details`, with no fixed shape. Each schema can add its own typed sub-fields inside an open extension point.
- **Components** — Reusable schema fragments, for example `address` or `contact`. A schema or another component references a component with `$ref`. Components can nest inside other components.
  - **Extract Component** pulls an existing inline shape out into a new, reusable component. It finds and updates the correct file, even when the shape is nested inside another component.
  - **Component links** (in the Constraints tab) link a field to an existing component. Pick the field and the component from two dropdowns. The tool writes the correct `-- component: <name>` comment for you.
- **Example-driven schema authoring** — Type an annotated JSON example. The tool derives `properties` and `required` from it. Fields are optional by default. Add a `-- required` comment to a field to make it required. You can also use the "Required fields" picker in the Constraints tab. A value like `"card,check"` declares an enum with two values.
- **Constraints** — The Constraints tab holds three things: the required-fields list, component links, and conditional rules. A rule reads `WHEN field = X THEN require/forbid/restrict other fields`. Rules can target nested fields, for example `contact.email`. The tool compiles rules to standard JSON Schema `allOf`/`if`/`then`.
- **Examples** — Every schema shows three kinds of example: a synthesized "Full" example with every field filled in, the current annotated example ("Primary"), and any hand-authored fixture files.
- **Fixture staleness detection and repair** — Fixtures are static files. Nothing updates them automatically when a schema, component, or base changes. The tool checks each fixture against the schema's current resolved output and flags any fixture that is now invalid. Click "Refresh Examples" to fix missing-required-field errors and add newly-added optional fields. This action never changes an existing value.

## Getting started

```bash
npm install
npm run dev
```

Open `http://localhost:5173`. The API server runs on port `3001`. The Vite dev server forwards `/api` requests to it.

## Project structure

```
/registry                      # the actual schema data, one folder per family
  registry.json                 # list of families and descriptions
  /<family>
    family.json
    base.schema.json            # locked base config for this family
    /components/*.schema.json
    /schemas/*.schema.json
    /tests/<schema>/*.json      # hand-authored fixtures

/server                        # Fastify API (Node.js, TypeScript)
  src/lib/                      # resolver, rule compiler, example derivation, extraction, fixture validation and repair
  src/routes/                   # one file per resource

/client                        # React + Vite frontend
  src/components/                # schema editor, rule builder, field pickers, tree viewer
```

## Tech stack

- **Backend**: Node.js, TypeScript, Fastify, ajv
- **Frontend**: React, TypeScript, Vite, Monaco Editor
- **Storage**: flat JSON files under `/registry`, tracked with git

## License

MIT. See [LICENSE](LICENSE).
