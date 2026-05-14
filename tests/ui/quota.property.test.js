// Feature: sql-coach, Property 12: Persistence failure ⇔ export entry visibility
// Validates: Requirements R15.6

import { describe, expect, beforeEach, it } from 'vitest';
import { test, fc } from '@fast-check/vitest';
import {
  shouldShowExportDialog,
  renderQuotaDialog,
} from '../../src/ui/quota-dialog.js';

// Outcome arbitrary: either {ok: true} or {ok: false, quotaExceeded: true}.
const outcomeArb = fc.oneof(
  fc.constant({ ok: true }),
  fc.constant({ ok: false, quotaExceeded: true }),
);

describe('Property 12 — shouldShowExportDialog is the pure binding', () => {
  test.prop([fc.array(outcomeArb, { minLength: 1, maxLength: 20 })])(
    'visible iff most-recent outcome was {ok:false, quotaExceeded:true}',
    (sequence) => {
      const last = sequence[sequence.length - 1];
      const expected = last && last.ok === false && last.quotaExceeded === true;
      expect(shouldShowExportDialog(last)).toBe(Boolean(expected));
    },
  );

  it('returns false for nullish outcomes', () => {
    expect(shouldShowExportDialog(null)).toBe(false);
    expect(shouldShowExportDialog(undefined)).toBe(false);
  });

  it('returns false for {ok:false} without quotaExceeded', () => {
    expect(shouldShowExportDialog({ ok: false })).toBe(false);
    expect(shouldShowExportDialog({ ok: false, error: 'something else' })).toBe(false);
  });
});

describe('Property 12 — DOM render mirrors the pure binding', () => {
  let root;
  let store;

  beforeEach(() => {
    root = document.createElement('div');
    document.body.appendChild(root);
    store = {
      exportAll: () => '{}',
    };
  });

  test.prop([fc.array(outcomeArb, { minLength: 1, maxLength: 10 })])(
    'after a sequence of outcomes, dialog visible iff last was quotaExceeded',
    (sequence) => {
      let lastOutcome = null;
      for (const o of sequence) {
        lastOutcome = o;
        renderQuotaDialog(root, { lastOutcome, store });
      }
      const visible = root.querySelector('[data-quota-dialog]');
      const lastIsQuota = lastOutcome
        && lastOutcome.ok === false
        && lastOutcome.quotaExceeded === true;
      if (lastIsQuota) {
        expect(visible).not.toBeNull();
      } else {
        expect(visible).toBeNull();
      }
    },
  );

  it('export button is present and triggers store.exportAll', () => {
    let exported = 0;
    const localStore = { exportAll: () => { exported++; return '{"a":1}'; } };
    renderQuotaDialog(root, {
      lastOutcome: { ok: false, quotaExceeded: true },
      store: localStore,
    });
    const btn = root.querySelector('[data-quota-export]');
    expect(btn).not.toBeNull();
    btn.click();
    expect(exported).toBe(1);
  });
});
