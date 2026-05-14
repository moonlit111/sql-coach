// SQL tokenizer for the MySQL_Compatible_Subset.
// Produces flat token streams used by parser, formatter and safety filter.
// Tokens: { type, value, start, end }
//   type ∈ 'keyword' | 'identifier' | 'number' | 'string' | 'operator' | 'punctuation' | 'whitespace' | 'comment'

const KEYWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'GROUP', 'BY', 'HAVING', 'ORDER', 'LIMIT', 'OFFSET',
  'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS', 'NATURAL', 'ON',
  'UNION', 'INTERSECT', 'EXCEPT', 'ALL', 'DISTINCT',
  'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE',
  'CREATE', 'TABLE', 'PRIMARY', 'KEY', 'FOREIGN', 'REFERENCES', 'UNIQUE',
  'NOT', 'NULL', 'DEFAULT', 'EXISTS', 'IN', 'BETWEEN', 'LIKE', 'IS', 'AS',
  'AND', 'OR', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
  'DROP', 'ALTER', 'TRUNCATE', 'ATTACH', 'DETACH', 'PRAGMA', 'REPLACE',
  'DATABASE', 'COLUMN', 'ADD',
]);

function isDigit(ch) { return ch >= '0' && ch <= '9'; }
function isIdentStart(ch) {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_';
}
function isIdentPart(ch) {
  return isIdentStart(ch) || isDigit(ch);
}

/**
 * Tokenize a SQL string. Throws on illegal characters or unterminated strings.
 * @param {string} sql
 * @returns {Array<{type: string, value: string, start: number, end: number}>}
 */
export function tokenize(sql) {
  if (typeof sql !== 'string') throw new Error('tokenize: input must be a string');
  const tokens = [];
  const n = sql.length;
  let i = 0;

  while (i < n) {
    const ch = sql[i];
    const start = i;

    // whitespace
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      let j = i + 1;
      while (j < n) {
        const c = sql[j];
        if (c === ' ' || c === '\t' || c === '\n' || c === '\r') j++;
        else break;
      }
      tokens.push({ type: 'whitespace', value: sql.slice(i, j), start, end: j });
      i = j;
      continue;
    }

    // line comment --
    if (ch === '-' && sql[i + 1] === '-') {
      let j = i + 2;
      while (j < n && sql[j] !== '\n') j++;
      tokens.push({ type: 'comment', value: sql.slice(i, j), start, end: j });
      i = j;
      continue;
    }

    // block comment /* ... */
    if (ch === '/' && sql[i + 1] === '*') {
      let j = i + 2;
      while (j < n - 1 && !(sql[j] === '*' && sql[j + 1] === '/')) j++;
      if (j >= n - 1) throw new Error('tokenize: unterminated block comment');
      j += 2;
      tokens.push({ type: 'comment', value: sql.slice(i, j), start, end: j });
      i = j;
      continue;
    }

    // single-quoted string with '' escape
    if (ch === "'") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") { j += 2; continue; } // doubled quote escape
          j++; break;
        }
        j++;
      }
      if (j > n || (sql[j - 1] !== "'")) {
        // either j hit n without seeing a closing quote
        if (j === n && sql[n - 1] !== "'") throw new Error('tokenize: unterminated string literal');
        if (j > n) throw new Error('tokenize: unterminated string literal');
      }
      tokens.push({ type: 'string', value: sql.slice(i, j), start, end: j });
      i = j;
      continue;
    }

    // backtick-quoted identifier
    if (ch === '`') {
      let j = i + 1;
      while (j < n && sql[j] !== '`') j++;
      if (j >= n) throw new Error('tokenize: unterminated backtick identifier');
      j += 1;
      tokens.push({ type: 'identifier', value: sql.slice(i, j), start, end: j });
      i = j;
      continue;
    }

    // number
    if (isDigit(ch)) {
      let j = i + 1;
      while (j < n && isDigit(sql[j])) j++;
      if (sql[j] === '.' && isDigit(sql[j + 1])) {
        j += 1;
        while (j < n && isDigit(sql[j])) j++;
      }
      tokens.push({ type: 'number', value: sql.slice(i, j), start, end: j });
      i = j;
      continue;
    }

    // identifier or keyword
    if (isIdentStart(ch)) {
      let j = i + 1;
      while (j < n && isIdentPart(sql[j])) j++;
      const raw = sql.slice(i, j);
      const upper = raw.toUpperCase();
      if (KEYWORDS.has(upper)) {
        tokens.push({ type: 'keyword', value: upper, start, end: j });
      } else {
        tokens.push({ type: 'identifier', value: raw, start, end: j });
      }
      i = j;
      continue;
    }

    // multi-char operators
    if (ch === '!' && sql[i + 1] === '=') {
      tokens.push({ type: 'operator', value: '!=', start, end: i + 2 });
      i += 2; continue;
    }
    if (ch === '<' && sql[i + 1] === '>') {
      tokens.push({ type: 'operator', value: '<>', start, end: i + 2 });
      i += 2; continue;
    }
    if (ch === '<' && sql[i + 1] === '=') {
      tokens.push({ type: 'operator', value: '<=', start, end: i + 2 });
      i += 2; continue;
    }
    if (ch === '>' && sql[i + 1] === '=') {
      tokens.push({ type: 'operator', value: '>=', start, end: i + 2 });
      i += 2; continue;
    }

    // single-char operators
    if (ch === '=' || ch === '<' || ch === '>' || ch === '+' || ch === '-' ||
        ch === '*' || ch === '/' || ch === '%') {
      tokens.push({ type: 'operator', value: ch, start, end: i + 1 });
      i += 1; continue;
    }

    // punctuation
    if (ch === '(' || ch === ')' || ch === ',' || ch === ';' || ch === '.') {
      tokens.push({ type: 'punctuation', value: ch, start, end: i + 1 });
      i += 1; continue;
    }

    throw new Error(`tokenize: unexpected character '${ch}' at position ${i}`);
  }

  return tokens;
}

/**
 * Drop whitespace and comment tokens.
 * @param {Array} tokens
 */
export function stripNoise(tokens) {
  return tokens.filter((t) => t.type !== 'whitespace' && t.type !== 'comment');
}
