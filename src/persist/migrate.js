// Persistence schema migration scaffold.
// Validates: R15.1, R15.2, R15.3

import { CURRENT_SCHEMA_VERSION } from './schema.js';

/**
 * No-op migration scaffold for v1. When a v2 schema is introduced, add a
 * branch keyed on `currentVersion` and return the upgraded version after
 * applying the transformations to localStorage.
 *
 * @param {number | null | undefined} currentVersion
 * @returns {number} the resulting schema version
 */
export function migrate(currentVersion) {
  if (currentVersion === undefined || currentVersion === null) {
    return CURRENT_SCHEMA_VERSION;
  }
  return currentVersion; // v1 only — no migrations yet
}
