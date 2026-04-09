import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { config } from "./config.js";
import type { StoredSecrets } from "./types.js";

const client = config.dryRun ? null : new SecretsManagerClient({ region: config.awsRegion });

let cached: StoredSecrets | null = null;

export async function getSecrets(): Promise<StoredSecrets> {
  if (cached) return cached;

  if (config.dryRun) {
    console.log("[secrets:load] DRY RUN: Returning mock secrets");
    cached = {
      GITHUB_APP_CLIENT_ID: "dry-run-client-id",
      GITHUB_APP_PRIVATE_KEY: "dry-run-private-key",
      GITHUB_APP_INSTALLATION_ID: "dry-run-installation-id",
      LINEAR_WEBHOOK_SECRET: "dry-run-webhook-secret",
      LINEAR_CLIENT_ID: "dry-run-client-id",
      LINEAR_CLIENT_SECRET: "dry-run-client-secret",
      CLAUDE_CODE_OAUTH_TOKEN: "dry-run-claude-token",
    };
    return cached;
  }

  const resp = await client!.send(
    new GetSecretValueCommand({ SecretId: config.secretName }),
  );

  if (!resp.SecretString) {
    throw new Error(`Secret ${config.secretName} has no string value`);
  }

  cached = JSON.parse(resp.SecretString) as StoredSecrets;
  return cached;
}
