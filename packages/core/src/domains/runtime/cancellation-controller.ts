/**
 * Run-local owner for cancellation admission and work that must settle before
 * Runtime can publish a cancelled terminal Event.
 */
export class CancellationController {
  readonly #abortController = new AbortController();
  readonly #jobs = new Map<number, string>();
  readonly #quiescenceWaiters = new Set<() => void>();
  #fenced = false;
  #nextJobId = 0;

  get signal(): AbortSignal {
    return this.#abortController.signal;
  }

  get activeJobCount(): number {
    return this.#jobs.size;
  }

  get isFenced(): boolean {
    return this.#fenced;
  }

  /**
   * Start and register one owned operation without yielding between the fence
   * check and the operation's first synchronous instruction.
   */
  startJob<T>(label: string, start: () => T | PromiseLike<T>): Promise<T> | undefined {
    if (this.#fenced || this.signal.aborted) return undefined;

    const jobId = ++this.#nextJobId;
    let operation: Promise<T>;
    try {
      operation = Promise.resolve(start());
    } catch (error) {
      operation = Promise.reject(error);
    }
    this.#jobs.set(jobId, label);
    void operation.then(
      () => this.#settleJob(jobId),
      () => this.#settleJob(jobId),
    );
    return operation;
  }

  /** Fence future dispatches before delivering cancellation to active work. */
  abort(reason?: unknown): void {
    if (this.#fenced) return;
    this.fence();
    this.#abortController.abort(reason);
  }

  /** Fence future dispatches after any terminal transition without aborting work. */
  fence(): void {
    this.#fenced = true;
  }

  /**
   * Wait at most `timeoutMs` for all already-admitted jobs to settle. A false
   * result is not proof of quiescence; callers must leave cancellation pending.
   */
  async waitForQuiescence(timeoutMs: number): Promise<boolean> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
      throw new TypeError("timeoutMs must be a non-negative safe integer");
    }
    if (this.#jobs.size === 0) return true;
    if (timeoutMs === 0) return false;

    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe = (): void => undefined;
    const quiescent = new Promise<void>((resolve) => {
      unsubscribe = this.#subscribeToQuiescence(resolve);
    });
    const elapsed = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    await Promise.race([quiescent, elapsed]);
    if (timer !== undefined) clearTimeout(timer);
    unsubscribe();
    return this.#jobs.size === 0;
  }

  /** Run a callback once the controller has no active jobs. */
  onQuiescent(callback: () => void): () => void {
    return this.#subscribeToQuiescence(callback);
  }

  #subscribeToQuiescence(callback: () => void): () => void {
    if (this.#jobs.size === 0) {
      queueMicrotask(callback);
      return () => undefined;
    }
    this.#quiescenceWaiters.add(callback);
    return () => this.#quiescenceWaiters.delete(callback);
  }

  #settleJob(jobId: number): void {
    this.#jobs.delete(jobId);
    if (this.#jobs.size !== 0) return;
    for (const waiter of this.#quiescenceWaiters) waiter();
    this.#quiescenceWaiters.clear();
  }
}
