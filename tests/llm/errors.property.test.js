// Feature: sqlense, Property 4: LLM error classification coverage and priority
// Validates: Requirements R3.1, R3.3, R14.1, R14.2, R14.3, R14.4, R14.6

import { describe, it, expect } from 'vitest';
import { test, fc } from '@fast-check/vitest';
import {
  classifyError,
  displayedError,
  LLM_ERROR_PRIORITY,
} from '../../src/llm/errors.js';

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

/** Build a minimal Response-shaped object that quacks like fetch's `Response`. */
function fakeResponse(status, headers = {}) {
  // normalize header keys to lowercase for the .get() lookup
  const lower = {};
  for (const k of Object.keys(headers)) lower[k.toLowerCase()] = headers[k];
  return {
    status,
    headers: { get: (k) => (k in lower ? lower[k] : (lower[String(k).toLowerCase()] ?? null)) },
  };
}

function makeAbortError(message = 'aborted') {
  const e = new Error(message);
  e.name = 'AbortError';
  return e;
}

// ----------------------------------------------------------------------------
// Example tests — concrete cases for each branch
// ----------------------------------------------------------------------------

describe('classifyError — example cases', () => {
  it('401 → unauthorized', () => {
    const c = classifyError(fakeResponse(401));
    expect(c.kind).toBe('unauthorized');
    expect(c.status).toBe(401);
  });

  it('403 → unauthorized', () => {
    const c = classifyError(fakeResponse(403));
    expect(c.kind).toBe('unauthorized');
    expect(c.status).toBe(403);
  });

  it('429 → rate_limited; integer Retry-After in seconds becomes ms', () => {
    const c = classifyError(fakeResponse(429, { 'retry-after': '30' }));
    expect(c.kind).toBe('rate_limited');
    expect(c.status).toBe(429);
    expect(c.retryAfterMs).toBe(30_000);
  });

  it('429 without Retry-After → rate_limited without retryAfterMs', () => {
    const c = classifyError(fakeResponse(429));
    expect(c.kind).toBe('rate_limited');
    expect('retryAfterMs' in c).toBe(false);
  });

  it('500/502/503/504 → server_error', () => {
    for (const s of [500, 502, 503, 504, 599]) {
      const c = classifyError(fakeResponse(s));
      expect(c.kind).toBe('server_error');
      expect(c.status).toBe(s);
    }
  });

  it('AbortError → timeout', () => {
    const c = classifyError(makeAbortError());
    expect(c.kind).toBe('timeout');
  });

  it('TypeError("Failed to fetch") → cors', () => {
    const c = classifyError(new TypeError('Failed to fetch'));
    expect(c.kind).toBe('cors');
    // R3.1 requires the user-facing message to mention CORS
    expect(c.message).toMatch(/CORS/);
  });

  it('generic Error → network', () => {
    const c = classifyError(new Error('connection reset'));
    expect(c.kind).toBe('network');
    expect(c.message).toMatch(/connection reset/);
  });

  it('unrecognized non-Error / no status → bad_response', () => {
    expect(classifyError(undefined).kind).toBe('bad_response');
    expect(classifyError(null).kind).toBe('bad_response');
    expect(classifyError({}).kind).toBe('bad_response');
    expect(classifyError('weird').kind).toBe('bad_response');
  });
});

describe('displayedError — example cases', () => {
  it('empty set returns null', () => {
    expect(displayedError([])).toBeNull();
    expect(displayedError(new Set())).toBeNull();
    expect(displayedError(undefined)).toBeNull();
  });

  it('picks unauthorized over cors (priority)', () => {
    const picked = displayedError([{ kind: 'cors' }, { kind: 'unauthorized' }]);
    expect(picked.kind).toBe('unauthorized');
  });

  it('picks rate_limited over server_error', () => {
    const picked = displayedError([
      { kind: 'server_error' },
      { kind: 'rate_limited' },
    ]);
    expect(picked.kind).toBe('rate_limited');
  });
});

// ----------------------------------------------------------------------------
// Property-based tests
// ----------------------------------------------------------------------------

describe('classifyError — properties', () => {
  test.prop([fc.constantFrom(401, 403)])(
    'status 401/403 → unauthorized',
    (status) => {
      const c = classifyError(fakeResponse(status));
      expect(c.kind).toBe('unauthorized');
      expect(c.status).toBe(status);
    }
  );

  test.prop([fc.integer({ min: 1, max: 86400 })])(
    'status 429 with Retry-After: N seconds → rate_limited with retryAfterMs = N*1000',
    (seconds) => {
      const c = classifyError(
        fakeResponse(429, { 'retry-after': String(seconds) })
      );
      expect(c.kind).toBe('rate_limited');
      expect(c.status).toBe(429);
      expect(c.retryAfterMs).toBe(seconds * 1000);
    }
  );

  test.prop([fc.integer({ min: 500, max: 599 })])(
    'status 500–599 → server_error',
    (status) => {
      const c = classifyError(fakeResponse(status));
      expect(c.kind).toBe('server_error');
      expect(c.status).toBe(status);
    }
  );

  test.prop([fc.string()])('AbortError → timeout', (msg) => {
    const c = classifyError(makeAbortError(msg));
    expect(c.kind).toBe('timeout');
  });

  test.prop([fc.string()])('TypeError → cors', (msg) => {
    const c = classifyError(new TypeError(msg || 'Failed to fetch'));
    expect(c.kind).toBe('cors');
  });

  test.prop([fc.string()])(
    'generic Error (not AbortError, not TypeError) → network',
    (msg) => {
      const e = new Error(msg);
      const c = classifyError(e);
      expect(c.kind).toBe('network');
    }
  );
});

describe('displayedError — priority property', () => {
  // Build an arbitrary subset of LLM_ERROR_PRIORITY (non-empty) and a payload
  // for each kind, then assert the picked kind is the one with the smallest
  // priority index.
  const errorObjFor = (kind) => {
    switch (kind) {
      case 'unauthorized':
        return { kind, status: 401, message: 'x' };
      case 'rate_limited':
        return { kind, status: 429, message: 'x' };
      case 'server_error':
        return { kind, status: 500, message: 'x' };
      default:
        return { kind, message: 'x' };
    }
  };

  test.prop([
    fc
      .subarray(LLM_ERROR_PRIORITY, { minLength: 1 })
      .chain((kinds) => fc.constant(kinds.map(errorObjFor))),
  ])('non-empty set → highest-priority kind wins', (errors) => {
    const picked = displayedError(errors);
    expect(picked).not.toBeNull();
    const expected = LLM_ERROR_PRIORITY.find((k) =>
      errors.some((e) => e.kind === k)
    );
    expect(picked.kind).toBe(expected);
  });

  test.prop([fc.subarray(LLM_ERROR_PRIORITY)])(
    'empty set → null; otherwise non-null',
    (kinds) => {
      const errors = kinds.map(errorObjFor);
      const picked = displayedError(errors);
      if (errors.length === 0) {
        expect(picked).toBeNull();
      } else {
        expect(picked).not.toBeNull();
        expect(LLM_ERROR_PRIORITY).toContain(picked.kind);
      }
    }
  );

  test.prop([
    fc
      .subarray(LLM_ERROR_PRIORITY, { minLength: 1 })
      .chain((kinds) => fc.constant(kinds.map(errorObjFor))),
  ])('order of input does not change the displayed pick', (errors) => {
    const reversed = [...errors].reverse();
    expect(displayedError(errors).kind).toBe(displayedError(reversed).kind);
  });
});
