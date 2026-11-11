/**
 * Codex legacy store domain: the file-backed account bookkeeping.
 * `codex/sequence.json` rows carry email/accountId/authMode; the live login
 * is `$CODEX_HOME/auth.json` (default `~/.codex/auth.json`).
 */

import { createHash } from "node:crypto";
import { z } from "zod";

const codexAuthSchema = z
  .object({
    auth_mode: z.string().default("unknown"),
    tokens: z.record(z.string(), z.unknown()).default({}),
    agent_identity: z.record(z.string(), z.unknown()).default({}),
    OPENAI_API_KEY: z.string().optional(),
  })
  .catchall(z.unknown());

export type CodexAuth = z.output<typeof codexAuthSchema>;

export function parseCodexAuth(raw: unknown): CodexAuth | null {
  try {
    return codexAuthSchema.parse(raw);
  } catch {
    return null;
  }
}

function decodeJwtEmail(idToken: unknown): string | null {
  if (typeof idToken !== "string") return null;
  const parts = idToken.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1] as string, "base64").toString("utf-8")) as Record<string, unknown>;
    const email = payload["email"];
    return typeof email === "string" && email !== "" ? email : null;
  } catch {
    return null;
  }
}

/** `(email, accountId, mode)` — Python `_identity_from_auth` parity. */
export function codexIdentity(auth: CodexAuth): { email: string; accountId: string; mode: string } {
  const mode = auth.auth_mode || "unknown";
  const tokens = auth.tokens;
  let email = decodeJwtEmail(tokens["id_token"]);
  if (!email) {
    const agent = auth.agent_identity;
    if (typeof agent["email"] === "string" && agent["email"] !== "") email = agent["email"];
  }
  let accountId = "";
  const tokenAccount = tokens["account_id"];
  if (typeof tokenAccount === "string" && tokenAccount !== "") accountId = tokenAccount;
  if (!accountId && typeof auth.OPENAI_API_KEY === "string") {
    const digest = createHash("sha256").update(auth.OPENAI_API_KEY).digest("hex").slice(0, 10);
    if (!email) email = `api-key-${digest}@codex.local`;
    accountId = accountId || email;
  }
  if (!email) return { email: "", accountId: "", mode };
  return { email, accountId: accountId || email, mode };
}
