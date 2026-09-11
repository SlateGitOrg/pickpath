import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ReservationLedger, OfflineQueue } from '../src/sync.ts';
import { simulatePartitions, simulateLastWriteWins } from '../src/partition.ts';

describe('500 induced double-picks', () => {
  test('THE HEADLINE: zero silent losses', () => {
    const r = simulatePartitions({ partitions: 500, seed: 7 });
    assert.equal(r.silentLosses, 0,
      `${r.silentLosses} picks disappeared without being applied or excepted`);
  });

  test('every conflict produces exactly one exception task', () => {
    const r = simulatePartitions({ partitions: 500, seed: 7 });
    assert.equal(r.inducedDoublePicks, 500);
    assert.equal(r.applied, 500, 'one picker per SKU should succeed');
    assert.equal(r.exceptions, 500, 'the other should raise exactly one exception');
  });

  test('stock never goes negative', () => {
    const r = simulatePartitions({ partitions: 500, seed: 7 });
    assert.equal(r.stockWentNegative, false,
      'the invariant a CRDT merge would have violated');
  });

  test('replaying the whole queue twice changes nothing', () => {
    const once = simulatePartitions({ partitions: 200, seed: 3 });
    const twice = simulatePartitions({ partitions: 200, seed: 3, replayTwice: true });
    assert.equal(twice.applied, once.applied);
    assert.equal(twice.exceptions, once.exceptions);
    assert.equal(twice.silentLosses, 0);
    assert.ok(twice.duplicates > 0, 'the second replay should be recognised');
  });

  test('the result is deterministic for a given seed', () => {
    const a = simulatePartitions({ partitions: 100, seed: 42 });
    const b = simulatePartitions({ partitions: 100, seed: 42 });
    assert.deepEqual(a, b, 'a non-reproducible simulation is not a bug report');
  });

  test('THE COMPARISON: last-write-wins loses one pick per conflict, silently', () => {
    const lww = simulateLastWriteWins(500);
    const ours = simulatePartitions({ partitions: 500, seed: 7 });
    assert.equal(lww.lostPicks, 500);
    assert.equal(ours.silentLosses, 0);
    // The difference is not that LWW is slower or less elegant. It is that 500
    // picks vanished with no record that they ever happened.
  });
});

describe('the exception task carries enough context to act on', () => {
  test('it names the other picker holding a reservation', () => {
    const l = new ReservationLedger();
    l.setStock('SKU-1', 1);
    l.reserve('alice', 'SKU-1', 1);
    l.reserve('bob', 'SKU-1', 1);
    l.apply({ pickerId: 'alice', clientSeq: 0, sku: 'SKU-1', qty: 1, takenAtMs: 1 });
    const out = l.apply({
      pickerId: 'bob', clientSeq: 0, sku: 'SKU-1', qty: 1, takenAtMs: 2,
    });
    assert.equal(out.kind, 'EXCEPTION');
    if (out.kind !== 'EXCEPTION') return;
    assert.equal(out.reason, 'INSUFFICIENT_STOCK');
    assert.equal(out.requested, 1);
    assert.equal(out.available, 0);
    assert.deepEqual(out.conflictsWith, ['alice']);
  });

  test('a pick with no reservation is an exception, not a silent accept', () => {
    const l = new ReservationLedger();
    l.setStock('SKU-9', 10);
    const out = l.apply({
      pickerId: 'rogue', clientSeq: 0, sku: 'SKU-9', qty: 1, takenAtMs: 1,
    });
    assert.equal(out.kind, 'EXCEPTION');
    if (out.kind === 'EXCEPTION') assert.equal(out.reason, 'NO_RESERVATION');
    assert.equal(l.stockOf('SKU-9'), 10, 'stock must not move on an exception');
  });

  test('picking more than reserved is an exception even when stock allows it', () => {
    const l = new ReservationLedger();
    l.setStock('SKU-2', 100);
    l.reserve('alice', 'SKU-2', 2);
    l.apply({ pickerId: 'alice', clientSeq: 0, sku: 'SKU-2', qty: 2, takenAtMs: 1 });
    const out = l.apply({
      pickerId: 'alice', clientSeq: 1, sku: 'SKU-2', qty: 1, takenAtMs: 2,
    });
    assert.equal(out.kind, 'EXCEPTION');
    if (out.kind === 'EXCEPTION') assert.equal(out.reason, 'RESERVATION_EXCEEDED');
  });

  test('one exception task is recorded per conflict, not one per retry', () => {
    const l = new ReservationLedger();
    l.setStock('SKU-3', 0);
    l.reserve('bob', 'SKU-3', 1);
    const a = { pickerId: 'bob', clientSeq: 0, sku: 'SKU-3', qty: 1, takenAtMs: 1 };
    l.apply(a); l.apply(a); l.apply(a);
    assert.equal(l.exceptionTasks.length, 1);
  });
});

describe('the offline queue', () => {
  test('replays in client sequence order regardless of arrival order', () => {
    const q = new OfflineQueue('carol');
    q.enqueue('A', 1, 10);
    q.enqueue('B', 1, 20);
    q.enqueue('C', 1, 30);
    const drained = q.drain();
    assert.deepEqual(drained.map((a) => a.sku), ['A', 'B', 'C']);
    assert.deepEqual(drained.map((a) => a.clientSeq), [0, 1, 2]);
  });

  test('draining empties the queue so a reconnect does not resend', () => {
    const q = new OfflineQueue('dave');
    q.enqueue('A', 1, 10);
    assert.equal(q.depth, 1);
    q.drain();
    assert.equal(q.depth, 0);
  });

  test('client sequence is monotonic across a long offline period', () => {
    const q = new OfflineQueue('erin');
    for (let i = 0; i < 500; i++) q.enqueue(`SKU-${i}`, 1, i);
    const seqs = q.drain().map((a) => a.clientSeq);
    for (let i = 1; i < seqs.length; i++) assert.equal(seqs[i], seqs[i - 1]! + 1);
  });
});
