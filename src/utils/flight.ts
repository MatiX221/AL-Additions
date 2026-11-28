import { createAbortError } from './helpers';

export interface SharedFlightWaiterOptions {
  signal?: AbortSignal;
  check?: () => void;
}

export interface SharedFlightOptions<T> {
  start: (signal: AbortSignal) => Promise<T>;
  onEvict?: (flight: SharedFlight<T>) => void;
  onSettled?: (flight: SharedFlight<T>) => void;
  createAbortError?: (signal?: AbortSignal) => Error;
}

export interface SharedFlight<T> {
  readonly controller: AbortController;
  readonly promise: Promise<T>;
  waiters: number;
  settled: boolean;
  readonly wait: (opts?: SharedFlightWaiterOptions) => Promise<T>;
}

const flightConfigs = new WeakMap<
  SharedFlight<any>,
  { makeAbortError: (signal?: AbortSignal) => Error; onEvict?: (flight: SharedFlight<any>) => void }
>();

/**
 * Attaches an isolated waiter to a SharedFlight.
 * Each waiter's signal/check cancels only that waiter; the shared controller is aborted
 * (and onEvict invoked synchronously) only when the last live waiter aborts before settlement.
 */
export function attachFlightWaiter<T>(
  flight: SharedFlight<T>,
  opts?: SharedFlightWaiterOptions
): Promise<T> {
  const cfg = flightConfigs.get(flight);
  const makeAbortError = cfg?.makeAbortError ?? createAbortError;
  const onEvict = cfg?.onEvict;
  const check = opts?.check;
  const signal = opts?.signal;

  try {
    check?.();
  } catch (err) {
    return Promise.reject(err);
  }
  if (signal?.aborted) {
    return Promise.reject(makeAbortError(signal));
  }

  flight.waiters++;
  if (!signal) {
    return flight.promise.then(
      (val) => {
        flight.waiters = Math.max(0, flight.waiters - 1);
        check?.();
        return val;
      },
      (err) => {
        flight.waiters = Math.max(0, flight.waiters - 1);
        throw err;
      }
    );
  }

  return new Promise<T>((resolve, reject) => {
    let done = false;
    const release = (): boolean => {
      if (done) return true;
      done = true;
      signal.removeEventListener('abort', onAbort);
      flight.waiters = Math.max(0, flight.waiters - 1);
      return false;
    };
    const onAbort = () => {
      if (release()) return;
      if (flight.waiters <= 0 && !flight.settled && !flight.controller.signal.aborted) {
        flight.controller.abort();
        onEvict?.(flight);
      }
      reject(makeAbortError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    flight.promise.then(
      (val) => {
        if (release()) return;
        try {
          check?.();
          resolve(val);
        } catch (err) {
          reject(err);
        }
      },
      (err) => {
        if (release()) return;
        reject(err);
      }
    );
  });
}

/**
 * Creates a waiter-isolated shared flight backed by a ref-counted AbortController.
 * Suppresses unhandled rejections on the shared promise when all waiters detach.
 */
export function createSharedFlight<T>(opts: SharedFlightOptions<T>): SharedFlight<T> {
  const controller = new AbortController();
  const makeAbortError = opts.createAbortError ?? createAbortError;

  const flight: SharedFlight<T> = {
    controller,
    promise: null as unknown as Promise<T>,
    waiters: 0,
    settled: false,
    wait: (waiterOpts) => attachFlightWaiter(flight, waiterOpts)
  };
  flightConfigs.set(flight, {
    makeAbortError,
    onEvict: opts.onEvict as ((f: SharedFlight<any>) => void) | undefined
  });

  let rawPromise: Promise<T>;
  try {
    rawPromise = opts.start(controller.signal);
  } catch (err) {
    rawPromise = Promise.reject(err);
  }

  const promise = rawPromise.then(
    (val) => {
      flight.settled = true;
      opts.onSettled?.(flight);
      return val;
    },
    (err) => {
      flight.settled = true;
      opts.onSettled?.(flight);
      throw err;
    }
  );
  // Prevent unhandled rejection when all waiters abort and detach from the shared flight.
  promise.catch(() => {});
  (flight as { promise: Promise<T> }).promise = promise;
  return flight;
}
