import { ReservationLedger, OfflineQueue, type ApplyOutcome } from './sync.ts';

/**
 * The deterministic partition simulator.
 *
 * Built early on purpose: you cannot develop offline-sync behaviour by
 * unplugging your laptop and hoping. Every double-pick below is INDUCED at a
 * known point, so "zero silent losses" is a count, not a belief.
 */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface PartitionResult {
  readonly inducedDoublePicks: number;
  readonly applied: number;
  readonly duplicates: number;
  readonly exceptions: number;
  /** Actions that vanished without being applied AND without an exception. */
  readonly silentLosses: number;
  readonly stockWentNegative: boolean;
}

export interface SimOptions {
  readonly partitions: number;
  readonly seed?: number;
  /** Replay each picker's queue twice, as an unreliable reconnect would. */
  readonly replayTwice?: boolean;
}

/**
 * Each "partition" is one contested SKU with exactly one unit of stock and two
 * pickers who both, offline, take it. Exactly one of them can be right.
 */
export function simulatePartitions(opts: SimOptions): PartitionResult {
  const rnd = mulberry32(opts.seed ?? 99);
  const ledger = new ReservationLedger();
  const outcomes: ApplyOutcome[] = [];
  let induced = 0;

  const queues: OfflineQueue[] = [];
  for (let p = 0; p < opts.partitions; p++) {
    const sku = `SKU-${p}`;
    ledger.setStock(sku, 1);

    const a = new OfflineQueue(`picker-A${p}`);
    const b = new OfflineQueue(`picker-B${p}`);
    // Both were assigned the last unit - the warehouse count was optimistic.
    ledger.reserve(`picker-A${p}`, sku, 1);
    ledger.reserve(`picker-B${p}`, sku, 1);

    const t = 1_000 + Math.floor(rnd() * 60_000);
    a.enqueue(sku, 1, t);
    b.enqueue(sku, 1, t + Math.floor(rnd() * 1_000));
    induced++;
    queues.push(a, b);
  }

  // Reconnects arrive in arbitrary order - that is the whole point.
  const order = [...queues].sort(() => rnd() - 0.5);
  const drained = order.map((q) => q.drain());
  for (const batch of drained) {
    for (const action of batch) outcomes.push(ledger.apply(action));
  }
  if (opts.replayTwice) {
    for (const batch of drained) {
      for (const action of batch) outcomes.push(ledger.apply(action));
    }
  }

  const applied = outcomes.filter((o) => o.kind === 'APPLIED').length;
  const duplicates = outcomes.filter((o) => o.kind === 'DUPLICATE').length;
  const exceptions = outcomes.filter((o) => o.kind === 'EXCEPTION').length;

  // Every submitted action must have been accounted for exactly once.
  const submitted = drained.flat().length;
  const decided = outcomes.filter((o) => o.kind !== 'DUPLICATE').length;
  const silentLosses = submitted - decided;

  let negative = false;
  for (let p = 0; p < opts.partitions; p++) {
    if (ledger.stockOf(`SKU-${p}`) < 0) negative = true;
  }

  return {
    inducedDoublePicks: induced, applied, duplicates, exceptions,
    silentLosses, stockWentNegative: negative,
  };
}

/** What a naive client would do instead: last write wins, no ledger. */
export function simulateLastWriteWins(partitions: number): {
  lostPicks: number; stockWentNegative: boolean;
} {
  let lost = 0;
  let negative = false;
  for (let p = 0; p < partitions; p++) {
    const stock = 1;
    // Both pickers write their own view of the world; the later write wins.
    const picks = 2;
    const remaining = stock - 1; // only the winner is recorded
    lost += picks - 1;           // the other pick is simply gone
    if (remaining < 0) negative = true;
  }
  return { lostPicks: lost, stockWentNegative: negative };
}
