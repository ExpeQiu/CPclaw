import type { DatabaseSync } from 'node:sqlite';
export function ensureConnectorPolicySchema(db:DatabaseSync):void {
 db.exec('CREATE TABLE IF NOT EXISTS org_connector_controls(org TEXT NOT NULL,id TEXT NOT NULL,blocked INTEGER NOT NULL,revision INTEGER NOT NULL,updated INTEGER NOT NULL,PRIMARY KEY(org,id))');
}
