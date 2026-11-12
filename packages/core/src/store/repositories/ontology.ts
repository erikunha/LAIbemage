/**
 * Ontology versions: immutable versions of the label taxonomy (spec 002).
 *
 * The taxonomy is versioned rather than edited: an annotation points at the
 * exact ontology version it was made against, and a changed category
 * description produces a NEW version with a NEW fingerprint (constitution IV).
 * The repository therefore offers no update method.
 */

import { OntologyVersionSchema, type OntologyCategory, type OntologyVersion } from '@vision-lens/contracts';
import type { SqliteDatabase } from '../db.js';
import { fromJsonColumn, toRequiredJsonColumn } from '../json.js';
import {
  BaseRepository,
  nullableText,
  optionalText,
  parseEntity,
  type Row,
} from './base.js';

/** The `ontology_versions` table. */
export class OntologyRepository extends BaseRepository {
  constructor(db: SqliteDatabase) {
    super(db);
  }

  /** Inserts an ontology version. */
  insert(version: OntologyVersion): OntologyVersion {
    const entity = parseEntity(OntologyVersionSchema, version, 'OntologyVersion');

    this.db
      .prepare(
        `INSERT INTO ontology_versions (
           id, version, categories_json, fingerprint, parent_id, created_at, updated_at
         ) VALUES (
           @id, @version, @categories_json, @fingerprint, @parent_id, @created_at, @updated_at
         )`,
      )
      .run({
        id: entity.id,
        version: entity.version,
        categories_json: toRequiredJsonColumn(entity.categories, 'categories_json'),
        fingerprint: entity.fingerprint,
        parent_id: nullableText(entity.parentId),
        created_at: entity.createdAt,
        updated_at: entity.createdAt,
      });

    return entity;
  }

  /** Reads an ontology version by id. */
  getById(id: string): OntologyVersion | undefined {
    const row = this.firstRow('SELECT * FROM ontology_versions WHERE id = @id', { id });
    return row ? toOntologyVersion(row) : undefined;
  }

  /** Reads an ontology version by its fingerprint. */
  findByFingerprint(fingerprint: string): OntologyVersion | undefined {
    const row = this.firstRow('SELECT * FROM ontology_versions WHERE fingerprint = @fingerprint', {
      fingerprint,
    });
    return row ? toOntologyVersion(row) : undefined;
  }

  /** Every version of one taxonomy lineage, oldest first. */
  listLineage(rootId: string): OntologyVersion[] {
    return this.allRows(
      `WITH RECURSIVE lineage(id, depth) AS (
         SELECT id, 0 FROM ontology_versions WHERE id = @root_id
         UNION ALL
         SELECT v.id, l.depth + 1 FROM ontology_versions v JOIN lineage l ON v.parent_id = l.id
       )
       SELECT v.* FROM ontology_versions v JOIN lineage l ON v.id = l.id
        ORDER BY l.depth, v.created_at, v.id`,
      { root_id: rootId },
    ).map(toOntologyVersion);
  }
}

/** Maps an `ontology_versions` row to the contract entity. */
export function toOntologyVersion(row: Row): OntologyVersion {
  return {
    id: row['id'] as string,
    version: row['version'] as string,
    categories:
      fromJsonColumn<OntologyCategory[]>(row['categories_json'] as string) ?? [],
    fingerprint: row['fingerprint'] as string,
    parentId: optionalText(row['parent_id']),
    createdAt: row['created_at'] as string,
  };
}
