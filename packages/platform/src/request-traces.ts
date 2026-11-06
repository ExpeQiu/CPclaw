import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,chmodSync} from 'node:fs';
import {join} from 'node:path';

/** Durable per-account request evidence, independent of rotating text logs. No request bodies. */
export function requestTraces(dataDir: string) {
  mkdirSync(dataDir,{recursive:true});
  const path=join(dataDir,'request-traces.sqlite'),db=new DatabaseSync(path);
  chmodSync(path,0o600);
  db.exec('CREATE TABLE IF NOT EXISTS request_traces(actor TEXT NOT NULL,request TEXT NOT NULL,updated INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(actor,request))');
  db.prepare("UPDATE request_traces SET body=json_set(body,'$.state','interrupted','$.code','PLATFORM_PROCESS_INTERRUPTED','$.finishedAt',?) WHERE json_extract(body,'$.state')='running'").run(Date.now());
  return {
    save(actor: string,id: string,record: object) {
      db.prepare('INSERT INTO request_traces VALUES(?,?,?,?) ON CONFLICT(actor,request) DO UPDATE SET updated=excluded.updated,body=excluded.body').run(actor,id,Date.now(),JSON.stringify(record));
      db.prepare('DELETE FROM request_traces WHERE updated<?').run(Date.now()-30*86400000);
      db.prepare('DELETE FROM request_traces WHERE actor=? AND request IN (SELECT request FROM request_traces WHERE actor=? ORDER BY updated DESC LIMIT -1 OFFSET 5000)').run(actor,actor);
    },
    read(actor: string,id: string): unknown {
      const row=db.prepare('SELECT body FROM request_traces WHERE actor=? AND request=? AND updated>=?').get(actor,id,Date.now()-30*86400000);
      return row?JSON.parse(String(row.body)):undefined;
    },
    close(){db.close();},
  };
}
