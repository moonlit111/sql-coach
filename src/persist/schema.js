// Persistence key schema and version constants.
// Validates: R15.1, R15.2, R15.3

/**
 * Canonical localStorage keys used by SQL Coach. Versioned per slot so a
 * future migration can introduce `*.v2` keys without colliding with v1.
 */
export const PersistKey = Object.freeze({
  SETTINGS:        'sqlcoach.settings.v1',
  CURRENT_SCHEMA:  'sqlcoach.schema.v1',
  /** Library of databases the user has generated or imported. Array of
   *  `{ id, name, ddl, seedSql, tables, createdAt, source }` records. */
  SCHEMA_LIBRARY:  'sqlcoach.schema_library.v1',
  QUESTION_BANK:   'sqlcoach.questions.v1',
  ANSWERS:         'sqlcoach.answers.v1',
  SESSIONS:        'sqlcoach.sessions.v1',
  SCHEMA_VERSION:  'sqlcoach.meta.schemaVersion',
});

/** Current persistence schema version. Bump when introducing breaking layout changes. */
export const CURRENT_SCHEMA_VERSION = 1;
