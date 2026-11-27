#!/usr/bin/env bun
/**
 * Mini-Benchmark: führt ein Shell-Kommando N-mal aus und meldet Median/Min.
 *   bun docs/toolchain-bench/bench.ts <name> <läufe> <cwd> -- <kommando …>
 */
const [name, laeufeText, cwd, trenner, ...kommando] = process.argv.slice(2);
if (name === undefined || cwd === undefined || trenner !== '--' || kommando.length === 0) {
  console.error('Aufruf: bench.ts <name> <läufe> <cwd> -- <kommando …>');
  process.exit(2);
}
const laeufe = Number(laeufeText);
const zeiten: number[] = [];
let exit = 0;
for (let i = 0; i < laeufe; i++) {
  const start = performance.now();
  const proc = Bun.spawn(['sh', '-c', kommando.join(' ')], {
    cwd,
    stdout: 'ignore',
    stderr: 'ignore',
  });
  exit = await proc.exited;
  zeiten.push(performance.now() - start);
}
zeiten.sort((a, b) => a - b);
const median = zeiten[Math.floor(zeiten.length / 2)] ?? 0;
console.log(
  `${name.padEnd(34)} median ${(median / 1000).toFixed(2)} s  min ${((zeiten[0] ?? 0) / 1000).toFixed(2)} s  (n=${laeufe}, exit ${exit})`,
);
