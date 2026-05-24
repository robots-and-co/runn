'use strict';

// Tracks active work time on a card. The card is considered "active" while
// its status is `doing`; on entering `doing` we stamp `doing_started_at`,
// on leaving `doing` we add the elapsed wall-clock time into `hours`.
//
// `review`/`done`/`todo`/`blocked` are all idle — review in particular is
// human approval time after AI work, not effort.

const HOURS_PER_MS = 1 / 3_600_000;

function round2(n) { return Math.round(n * 100) / 100; }

// Mutates `next` in place and returns it. `prev` is the on-disk card before
// the write (or undefined for a brand-new card). `nowIso` is the server's
// timestamp helper so all writes within a request share one wall clock.
function applyTimerTransition(prev, next, nowIso) {
  const prevStatus = prev && prev.status;
  const nextStatus = next.status;

  if (prevStatus === 'doing' && nextStatus !== 'doing') {
    const startedAt = prev.doing_started_at;
    if (startedAt) {
      const elapsedMs = Date.now() - new Date(startedAt).getTime();
      if (elapsedMs > 0) {
        const base = (typeof next.hours === 'number') ? next.hours : 0;
        next.hours = round2(base + elapsedMs * HOURS_PER_MS);
      }
    }
    next.doing_started_at = null;
  } else if (nextStatus === 'doing' && prevStatus !== 'doing') {
    next.doing_started_at = nowIso();
  }

  return next;
}

module.exports = { applyTimerTransition };
