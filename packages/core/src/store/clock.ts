/**
 * A monotonic clock for the store's own timestamps.
 *
 * The store stamps `created_at` / `updated_at` with millisecond-resolution
 * ISO-8601 strings. Two writes inside the same millisecond would produce
 * *equal* timestamps, which makes the "every write bumps `updated_at`"
 * invariant (spec 002, US2 scenario 3) unobservable — and therefore
 * untestable.
 *
 * `nextTimestamp()` therefore issues strictly increasing timestamps within a
 * process: it never returns a value at or below the previously issued one.
 * The clock is still wall-clock anchored (it advances with the system clock);
 * only the ordering is enforced. Cross-process ordering is NOT guaranteed —
 * the store is single-writer by assumption (see `db.ts`).
 */

/** Last timestamp issued by {@link nextTimestamp}, in epoch milliseconds. */
let lastIssued = 0;

/**
 * Returns the next timestamp, guaranteed to be strictly greater than the
 * previously issued one within this process.
 *
 * The value is an ISO-8601 string with a `Z` offset, which is exactly what
 * `z.iso.datetime({ offset: true })` accepts in the contracts.
 */
export function nextTimestamp(): string {
  const wall = Date.now();
  const next = wall > lastIssued ? wall : lastIssued + 1;
  lastIssued = next;
  return new Date(next).toISOString();
}

/**
 * Returns true when `candidate` is strictly newer than `previous`.
 *
 * Used by the repository tests to assert the `updated_at` bump without
 * sleeping: the store's clock is monotonic, so a subsequent write always
 * yields a strictly greater timestamp.
 */
export function isStrictlyAfter(candidate: string, previous: string): boolean {
  return Date.parse(candidate) > Date.parse(previous);
}
