import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { platformLog } from "./log.js";

export type AuthorityEntry = {
  kind: "knowledge" | "session" | "employee" | "channel_binding" | "conversation";
  id: string;
  at: number;
  orgId: string;
  actorId: string;
};

export type AuthorityLedger = {
  schemaVersion: 1;
  entries: AuthorityEntry[];
};

function ledgerPath(dataDir: string): string {
  return join(dataDir, "authority-ledger.json");
}

function emptyLedger(): AuthorityLedger {
  return { schemaVersion: 1, entries: [] };
}

/** 权威台账独立于 sqlite 备份。恢复旧库后仍会回放撤权。 */
export function readAuthorityLedger(dataDir: string): AuthorityLedger {
  const path = ledgerPath(dataDir);
  if (!existsSync(path)) {
    return emptyLedger();
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) {
      return emptyLedger();
    }
    const version = Reflect.get(parsed, "schemaVersion");
    const entries = Reflect.get(parsed, "entries");
    if (version !== 1 || !Array.isArray(entries)) {
      return emptyLedger();
    }
    const cleaned: AuthorityEntry[] = [];
    for (const item of entries) {
      if (typeof item !== "object" || item === null) {
        continue;
      }
      const kind = Reflect.get(item, "kind");
      const id = Reflect.get(item, "id");
      const at = Reflect.get(item, "at");
      const orgId = Reflect.get(item, "orgId");
      const actorId = Reflect.get(item, "actorId");
      if (
        (kind === "knowledge" ||
          kind === "session" ||
          kind === "employee" ||
          kind === "channel_binding" ||
          kind === "conversation") &&
        typeof id === "string" &&
        typeof at === "number" &&
        typeof orgId === "string" &&
        typeof actorId === "string"
      ) {
        cleaned.push({ kind, id, at, orgId, actorId });
      }
    }
    return { schemaVersion: 1, entries: cleaned };
  } catch {
    return emptyLedger();
  }
}

export function appendAuthorityRevocation(dataDir: string, entry: AuthorityEntry): void {
  const ledger = readAuthorityLedger(dataDir);
  const filtered = ledger.entries.filter((item) => !(item.kind === entry.kind && item.id === entry.id));
  filtered.push(entry);
  filtered.sort((a, b) => a.at - b.at);
  mkdirSync(dataDir, { recursive: true });
  const path = ledgerPath(dataDir);
  writeFileSync(path, `${JSON.stringify({ schemaVersion: 1, entries: filtered }, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  chmodSync(path, 0o600);
  platformLog(dataDir, "info", "authority_revocation_recorded", "权威撤权已写入台账", {
    kind: entry.kind,
    id: entry.id,
  });
}

/** 打开或恢复平台库后回放台账，避免旧备份重新开放已撤权资源。 */
export function applyAuthorityLedger(db: DatabaseSync, dataDir: string): { applied: number } {
  const ledger = readAuthorityLedger(dataDir);
  let applied = 0;
  for (const entry of ledger.entries) {
    if (entry.kind === "knowledge") {
      const result = db.prepare("UPDATE knowledge_docs SET status = 'revoked' WHERE doc_id = ? AND status != 'revoked'").run(
        entry.id,
      );
      applied += Number(result.changes ?? 0);
    } else if (entry.kind === "session") {
      const result = db.prepare("UPDATE sessions SET status = 'revoked' WHERE session_id = ? AND status = 'active'").run(entry.id);
      applied += Number(result.changes ?? 0);
    } else if (entry.kind === "employee") {
      const disabled = db.prepare("UPDATE employees SET status = 'disabled' WHERE employee_id = ? AND status != 'disabled'").run(
        entry.id,
      );
      const sessions = db.prepare("UPDATE sessions SET status = 'revoked' WHERE employee_id = ? AND status = 'active'").run(entry.id);
      applied += Number(disabled.changes ?? 0) + Number(sessions.changes ?? 0);
    } else if (entry.kind === "channel_binding") {
      const result = db
        .prepare("UPDATE identity_bindings SET status = 'revoked' WHERE binding_id = ? AND status = 'active'")
        .run(entry.id);
      applied += Number(result.changes ?? 0);
    } else if (entry.kind === "conversation") {
      const result = db
        .prepare("UPDATE conversation_bindings SET status = 'revoked' WHERE conversation_key = ? AND status = 'active'")
        .run(entry.id);
      applied += Number(result.changes ?? 0);
    }
  }
  if (applied > 0) {
    platformLog(dataDir, "info", "authority_ledger_applied", "恢复后已回放权威撤权", { applied });
  }
  return { applied };
}
