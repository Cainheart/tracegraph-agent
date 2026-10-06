/** Attempt every owned shutdown boundary while retaining a failed owner's lease. */
export async function closeOwnedResources(steps: readonly (() => void | Promise<void>)[]): Promise<void> {
  const failures: unknown[] = [];
  for (const step of steps) {
    try { await step(); } catch (error) { failures.push(error); }
  }
  if (failures.length > 0) throw new AggregateError(failures, "Outlive could not verify every resource stopped; its exclusive writer lease remains held");
}
