// Timeout helper used by the Sandbox.
//
// Wraps a promise with a soft timeout. The `onTimeout` callback fires once
// when the timer expires; it is the caller's responsibility to perform the
// hard cancellation (e.g. `worker.terminate()`).
//
// Validates: R10.2 (5s execution timeout), R11.3 (user SQL timeout).

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {() => void} [onTimeout]
 * @returns {Promise<T>}
 */
export function withTimeout(promise, ms, onTimeout) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try {
        onTimeout?.();
      } catch {
        // Swallow: callback errors must not mask the timeout.
      }
      const err = new Error(`Timeout after ${ms}ms`);
      err.name = 'TimeoutError';
      reject(err);
    }, ms);
    promise.then(
      (v) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}
