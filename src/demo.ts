/**
 * The 60-second artefact: 500 induced double-picks, two strategies.
 * Run: `npm run demo`
 */
import { simulatePartitions, simulateLastWriteWins } from './partition.ts';
import { ReservationLedger } from './sync.ts';

const N = 500;
const ours = simulatePartitions({ partitions: N, seed: 7, replayTwice: true });
const lww = simulateLastWriteWins(N);

console.log('\n  PICKPATH - 500 contested SKUs, two pickers each, all offline');
console.log('  ' + '-'.repeat(64));
console.log('  Every SKU has exactly 1 unit and 2 reservations. One picker must');
console.log('  be told no. The question is whether anyone finds out.\n');

console.log('  strategy                  applied  exceptions  SILENT LOSSES  stock < 0');
console.log('  ' + '-'.repeat(74));
console.log(`  reservation ledger        ${String(ours.applied).padEnd(9)}` +
            `${String(ours.exceptions).padEnd(12)}${String(ours.silentLosses).padEnd(15)}` +
            `${ours.stockWentNegative ? 'yes' : 'no'}`);
console.log(`  last-write-wins           ${String(N).padEnd(9)}${'0'.padEnd(12)}` +
            `${String(lww.lostPicks).padEnd(15)}` +
            `${lww.stockWentNegative ? 'yes' : 'no'}`);

console.log(`\n  The queue was replayed twice (an unreliable reconnect):`);
console.log(`  ${ours.duplicates} duplicate submissions recognised, outcome unchanged.\n`);

// What a supervisor actually receives.
const l = new ReservationLedger();
l.setStock('SKU-4471', 1);
l.reserve('alice', 'SKU-4471', 1);
l.reserve('bob', 'SKU-4471', 1);
l.apply({ pickerId: 'alice', clientSeq: 0, sku: 'SKU-4471', qty: 1, takenAtMs: 1 });
l.apply({ pickerId: 'bob', clientSeq: 0, sku: 'SKU-4471', qty: 1, takenAtMs: 2 });

console.log('  What the supervisor receives, 3 seconds after reconnect:');
for (const e of l.exceptionTasks) {
  console.log(`    SKU ${e.sku}  picker=${e.pickerId}  reason=${e.reason}`);
  console.log(`      requested ${e.requested}, available ${e.available}, ` +
              `conflicts with: ${e.conflictsWith.join(', ')}`);
}
console.log('\n  Under last-write-wins this is instead: nothing. No task, no log,');
console.log('  no discrepancy - until the customer opens a short box.\n');
