// Thin wrapper around simple-git, scoped to the repo root. Git history is our
// only version record (no semver) — this is what backs the future "History"
// tab in the viewer. Scaffold-only: log is wired up now, diff rendering in
// the UI is a follow-up iteration.

import { simpleGit } from "simple-git";
import path from "node:path";
import { REGISTRY_ROOT } from "./registryFs.js";

const REPO_ROOT = path.resolve(REGISTRY_ROOT, "..");
const git = simpleGit(REPO_ROOT);

export interface CommitInfo {
  hash: string;
  date: string;
  message: string;
}

export async function logForPath(absoluteFilePath: string): Promise<CommitInfo[]> {
  const relativePath = path.relative(REPO_ROOT, absoluteFilePath);
  try {
    const log = await git.log({ file: relativePath });
    return log.all.map((entry) => ({
      hash: entry.hash.slice(0, 7),
      date: entry.date,
      message: entry.message,
    }));
  } catch {
    // Not a git repo yet, or file has no history — return empty rather than
    // failing the request.
    return [];
  }
}
