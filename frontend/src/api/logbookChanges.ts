// When the logbook last changed on this device (a create, and later edits and deletes), so the
// list reloads on its next focus instead of waiting for its data to go stale. Memory only.
let changedAt = 0;

export function noteLogbookChanged(now = Date.now()): void {
  changedAt = Math.max(changedAt, now);
}

export function logbookChangedSince(time: number): boolean {
  return changedAt > 0 && changedAt >= time;
}

// After the account is deleted: nothing carries over to the next sign-in.
export function resetLogbookChanges(): void {
  changedAt = 0;
}
