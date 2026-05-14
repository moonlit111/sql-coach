// Prompt template re-exports.
// Each module exposes `buildPrompt` (and Tutor exposes `buildFirstMessage` /
// `buildFollowup`). Importing as namespaces keeps node code easy to read.

export * as schemaGenPrompt   from './schema-gen.js';
export * as questionGenPrompt from './question-gen.js';
export * as tutorPrompt       from './tutor.js';
export * as reporterPrompt    from './reporter.js';
