/**
 * Offline picking: the sync protocol and the reservation ledger.
 *
 * THE DIFFERENTIATOR LIVES HERE.
 *
 * Two pickers, both offline, both claim the last unit of an SKU. Something has
 * to give. The usual answers are both wrong for this problem:
 *
 *   last-write-wins  - silently discards one pick. The warehouse believes it
 *                      shipped; the customer discovers it did not.
 *   CRDT merge       - converges beautifully on a value that violates the only
 *                      invariant that matters: you cannot pick stock that is
 *                      not there. CRDTs are the right tool when concurrent
 *                      edits are all legal. Here one of them is not.
 *
 * So the server does not merge. It VALIDATES each offline action against a
 * reservation ledger, and where an action cannot be honoured it emits an
 * explicit exception task for a supervisor. Ambiguity escalates to a human
 * with both actions visible, because the cost of a wrong automatic answer is a
 * customer-visible short ship.
 */

export interface PickAction {
  readonly pickerId: string;
  /** Monotonic per picker. Establishes intent order within one device. */
  readonly clientSeq: number;
  readonly sku: string;
  readonly qty: number;
  readonly takenAtMs: number;
}

export type ApplyOutcome =
  | { kind: 'APPLIED'; sku: string; pickerId: string; clientSeq: number }
  | { kind: 'DUPLICATE'; sku: string; pickerId: string; clientSeq: number }
  | {
      kind: 'EXCEPTION';
      sku: string;
      pickerId: string;
      clientSeq: number;
      reason: 'NO_RESERVATION' | 'INSUFFICIENT_STOCK' | 'RESERVATION_EXCEEDED';
      requested: number;
      available: number;
      conflictsWith: readonly string[];
    };

export interface ExceptionTask extends Record<string, unknown> {
  readonly sku: string;
  readonly pickerId: string;
  readonly reason: string;
  readonly requested: number;
  readonly available: number;
  readonly conflictsWith: readonly string[];
}

interface Reservation {
  pickerId: string;
  sku: string;
  qty: number;
  consumed: number;
}

export class ReservationLedger {
  /** Physical stock on the shelf. */
  private stock = new Map<string, number>();
  /** Reservations issued when a pick list is assigned. */
  private reservations = new Map<string, Reservation>();
  /** Applied (pickerId, clientSeq) pairs - the idempotency key. */
  private applied = new Set<string>();
  private exceptions: ExceptionTask[] = [];

  setStock(sku: string, qty: number): void {
    this.stock.set(sku, qty);
  }
  stockOf(sku: string): number {
    return this.stock.get(sku) ?? 0;
  }

  /**
   * Assigning a pick list reserves stock. Deliberately allowed to OVERSELL -
   * a real warehouse assigns from a count that is already slightly wrong, and
   * pretending otherwise would design the conflict out of existence rather
   * than handling it.
   */
  reserve(pickerId: string, sku: string, qty: number): void {
    this.reservations.set(`${pickerId}:${sku}`, { pickerId, sku, qty, consumed: 0 });
  }

  private key(a: PickAction): string {
    return `${a.pickerId}#${a.clientSeq}`;
  }

  /** Who else holds a live reservation on this SKU. */
  private othersHolding(sku: string, exclude: string): string[] {
    const out: string[] = [];
    for (const r of this.reservations.values()) {
      if (r.sku === sku && r.pickerId !== exclude) out.push(r.pickerId);
    }
    return out.sort();
  }

  /**
   * Apply one offline action. Idempotent: replaying a queue is safe, which is
   * what makes an unreliable reconnect survivable.
   */
  apply(a: PickAction): ApplyOutcome {
    const k = this.key(a);
    if (this.applied.has(k)) {
      return {
        kind: 'DUPLICATE', sku: a.sku, pickerId: a.pickerId, clientSeq: a.clientSeq,
      };
    }

    const res = this.reservations.get(`${a.pickerId}:${a.sku}`);
    const available = this.stockOf(a.sku);

    const fail = (
      reason: 'NO_RESERVATION' | 'INSUFFICIENT_STOCK' | 'RESERVATION_EXCEEDED',
    ): ApplyOutcome => {
      const conflictsWith = this.othersHolding(a.sku, a.pickerId);
      this.exceptions.push({
        sku: a.sku, pickerId: a.pickerId, reason,
        requested: a.qty, available, conflictsWith,
      });
      this.applied.add(k); // an exception is still a decided action
      return {
        kind: 'EXCEPTION', sku: a.sku, pickerId: a.pickerId,
        clientSeq: a.clientSeq, reason, requested: a.qty, available, conflictsWith,
      };
    };

    if (!res) return fail('NO_RESERVATION');
    if (res.consumed + a.qty > res.qty) return fail('RESERVATION_EXCEEDED');
    if (a.qty > available) return fail('INSUFFICIENT_STOCK');

    res.consumed += a.qty;
    this.stock.set(a.sku, available - a.qty);
    this.applied.add(k);
    return {
      kind: 'APPLIED', sku: a.sku, pickerId: a.pickerId, clientSeq: a.clientSeq,
    };
  }

  get exceptionTasks(): readonly ExceptionTask[] {
    return this.exceptions;
  }
}

/**
 * The device-side durable queue. Actions accumulate offline in client sequence
 * order and are replayed on reconnect in that order, regardless of when they
 * happen to reach the server.
 */
export class OfflineQueue {
  private pending: PickAction[] = [];
  private seq = 0;
  private readonly pickerId: string;

  constructor(pickerId: string) {
    this.pickerId = pickerId;
  }

  enqueue(sku: string, qty: number, takenAtMs: number): PickAction {
    const a: PickAction = {
      pickerId: this.pickerId, clientSeq: this.seq++, sku, qty, takenAtMs,
    };
    this.pending.push(a);
    return a;
  }

  /** Drain in client order. Sorting here is the guarantee, not an accident. */
  drain(): PickAction[] {
    const out = [...this.pending].sort((x, y) => x.clientSeq - y.clientSeq);
    this.pending = [];
    return out;
  }

  get depth(): number {
    return this.pending.length;
  }
}
