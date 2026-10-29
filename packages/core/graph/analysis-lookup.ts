import type { AppDatabase } from '../db.js';
import type { Analysis } from './analysis-content.js';
export function migrateLookup(db: AppDatabase) {
  db.exec(`CREATE TABLE IF NOT EXISTS graph_analysis_lookup(note_id TEXT NOT NULL REFERENCES graph_analysis_sources(note_id) ON DELETE CASCADE,node_id TEXT NOT NULL,search_text TEXT NOT NULL,PRIMARY KEY(note_id,node_id));
 CREATE INDEX IF NOT EXISTS graph_analysis_lookup_node ON graph_analysis_lookup(node_id,note_id);
 CREATE TABLE IF NOT EXISTS graph_analysis_links(note_id TEXT NOT NULL REFERENCES graph_analysis_sources(note_id) ON DELETE CASCADE,target_path TEXT NOT NULL,PRIMARY KEY(note_id,target_path));
 CREATE INDEX IF NOT EXISTS graph_analysis_links_target ON graph_analysis_links(target_path,note_id);
 CREATE TABLE IF NOT EXISTS graph_analysis_candidates(note_id TEXT NOT NULL REFERENCES graph_analysis_sources(note_id) ON DELETE CASCADE,id TEXT NOT NULL,source TEXT NOT NULL,target TEXT NOT NULL,predicate TEXT NOT NULL,confidence REAL NOT NULL,PRIMARY KEY(note_id,id));
 CREATE INDEX IF NOT EXISTS graph_analysis_candidate_id ON graph_analysis_candidates(id,note_id);`);
  // One migration of derived records; no filesystem scan and no source content is sent to a provider.
  db.exec(`INSERT OR IGNORE INTO graph_analysis_lookup SELECT note_id,note_id,json_extract(data,'$.title')||' '||path FROM graph_analysis_sources;
 INSERT OR IGNORE INTO graph_analysis_lookup SELECT s.note_id,json_extract(e.value,'$.id'),json_extract(e.value,'$.name')||' '||coalesce(json_extract(e.value,'$.aliases'),'') FROM graph_analysis_sources s,json_each(s.data,'$.entities') e;
 INSERT OR IGNORE INTO graph_analysis_lookup SELECT s.note_id,json_extract(e.value,'$.id'),json_extract(e.value,'$.predicate') FROM graph_analysis_sources s,json_each(s.data,'$.relations') e;
 INSERT OR IGNORE INTO graph_analysis_candidates SELECT s.note_id,json_extract(e.value,'$.id'),json_extract(e.value,'$.source'),json_extract(e.value,'$.target'),json_extract(e.value,'$.predicate'),json_extract(e.value,'$.confidence') FROM graph_analysis_sources s,json_each(s.data,'$.relations') e WHERE json_extract(e.value,'$.method')='model';
 INSERT OR IGNORE INTO graph_analysis_links SELECT s.note_id,e.value FROM graph_analysis_sources s,json_each(s.data,'$.links') e;`);
}
export function publishLookup(db: AppDatabase, id: string, path: string, data: Analysis) {
  const add = db.prepare('INSERT OR REPLACE INTO graph_analysis_lookup VALUES(?,?,?)');
  add.run(id, id, data.title + ' ' + path);
  for (const entity of data.entities)
    add.run(id, entity.id, entity.name + ' ' + entity.aliases.join(' '));
  for (const relation of data.relations) add.run(id, relation.id, relation.predicate);
  const candidate = db.prepare(
    'INSERT OR REPLACE INTO graph_analysis_candidates VALUES(?,?,?,?,?,?)',
  );
  for (const relation of data.relations)
    if (relation.method === 'model')
      candidate.run(
        id,
        relation.id,
        relation.source,
        relation.target,
        relation.predicate,
        relation.confidence,
      );
  const link = db.prepare('INSERT OR IGNORE INTO graph_analysis_links VALUES(?,?)');
  for (const path of data.links) link.run(id, path);
}
