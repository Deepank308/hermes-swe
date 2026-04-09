import { readFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const promptsDir = resolve(__dirname, "../prompts");

export async function loadSystemPrompt(): Promise<string> {
  const repo = process.env.REPO;
  if (repo) {
    const repoShort = repo.split("/").pop()!;
    const repoPrompt = resolve(promptsDir, repoShort, "system.md");
    try {
      await access(repoPrompt);
      console.log(`[prompt-loader] Using repo-specific prompt: ${repo}`);
      return readFile(repoPrompt, "utf-8");
    } catch {
      // No repo-specific prompt — fall through to default
    }
  }
  console.log("[prompt-loader] Using default prompt");
  return readFile(resolve(promptsDir, "system.md"), "utf-8");
}
