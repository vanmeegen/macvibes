# Framework benchmark — summary

Consolidated, **measured** results for the four React stack candidates, plus the
Bun-vs-Node toolchain findings and the SPA "Bun-native" experiment. All numbers
were produced on the same machine with `benchmarks/bench.mjs` running an identical
Todo app (add / toggle / delete / filter + `localStorage`) per stack.

- Harness + methodology: [`../README.md`](../README.md)
- Scoring / verdicts: [`stack-comparison.md`](stack-comparison.md)
- Reproducible setups (node / bun / bun-native): [`../../stackcomparison/`](../../stackcomparison/)

---

## 1. Framework dev / build footprint

| Metric                         | Vite + React (PWA)† | React Router v7 | TanStack Start‡ |   Next.js 16 |
| ------------------------------ | ------------------: | --------------: | --------------: | -----------: |
| Packages / `node_modules`      |      622† / 309 MB† |    229 / 119 MB |   327‡ / 233 MB | 430 / 441 MB |
| Dev cold start → 200           |          **0.22 s** |          4.70 s |          1.05 s |       1.77 s |
| Dev warm start (median)        |          **0.25 s** |          0.62 s |          1.30 s |       1.66 s |
| Dev-server RSS                 |            ~460 MB† |     **~182 MB** |         ~380 MB |      ~736 MB |
| Dev-server processes           |                   2 |           **1** |           **1** |            3 |
| HMR reload (median)            |              114 ms |           87 ms |           98 ms |    **76 ms** |
| Client JS, total (gzip)        |          **83 KB†** |          100 KB |           98 KB |       182 KB |
| Largest JS chunk (gzip)        |              83 KB† |       **57 KB** |           97 KB |        69 KB |
| Unit test — Vitest, cold\*     |              2.69 s |          4.04 s |          6.10 s |       1.71 s |
| Unit test — Vitest, warm\*     |              0.45 s |          0.69 s |          1.00 s |       0.42 s |
| Unit test — `bun test`, warm\* |         **0.017 s** |     **0.016 s** |     **0.016 s** |  **0.017 s** |

† The **PWA row bundles the full PwC branded component kit** (recharts, exceljs,
Radix, base-ui, shadcn, TanStack Table); the other three are bare scaffolds with
plain Tailwind. So its package / `node_modules` / RSS / JS figures are inflated by
the kit, **not** the framework. Clean framework signals: **startup** (Vite ≪
TanStack ≈ Next ≪ RR-cold) and **dev-server RSS** (Next ≫ PWA ≫ TanStack ≫ RR).

‡ The **TanStack scaffold ships extra dev deps by default** (Vitest, jsdom,
Testing Library, devtools) that the RR / Next scaffolds do not — inflating its
package / `node_modules` count.

\* Unit-test rows use the identical 3-test pure-logic suite from the reproducible
`stackcomparison/` setups (`bench.mjs --only test`, 3 runs; first = cold, rest =
warm). The Vite column's test numbers come from the **clean** Vite SPA setup, not
the branded PWA.

---

## 2. Runtime: Bun vs Node — three axes

| Axis                                                | Result                                                                                                   | Verdict                         |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------- |
| **Dev-server runtime** (`node` vs `bun --bun`)      | Vite: no win (Bun slightly more RAM); RR v7: **crashes** (typegen bug, Bun 1.3.8); Next: **unsupported** | **Stay on Node**                |
| **Unit-test runner** (Vitest vs `bun test`)         | `bun test` **25–60× faster warm** (~16–18 ms flat), and drops the Vitest dep tree (−4 to −33 MB)         | **Adopt `bun test`** everywhere |
| **Package manager** (`pnpm`/`npm` vs `bun install`) | Bun's well-known install-speed win; CI / image-build concern only                                        | Adopt independently             |

### Unit-test execution detail (warm speed-up)

| Stack           | Node · Vitest (cold / warm) | Bun · `bun test` (cold / warm) | Warm speed-up |
| --------------- | --------------------------: | -----------------------------: | :-----------: |
| Vite SPA        |             2.69 s / 0.45 s |               0.08 s / 0.017 s |   **~26×**    |
| React Router v7 |             4.04 s / 0.69 s |              0.018 s / 0.016 s |   **~43×**    |
| TanStack Start  |             6.10 s / 1.00 s |              0.018 s / 0.016 s |   **~61×**    |
| Next.js         |             1.71 s / 0.42 s |              0.019 s / 0.017 s |   **~25×**    |

---

## 3. SPA toolchain variants (node / bun / bun-native)

Same client-only Todo SPA, three toolchains — answering "can Bun replace Vite
**and** Vitest?". Reproducible in
[`../../stackcomparison/vite-react-spa/`](../../stackcomparison/vite-react-spa/).

| Aspect               | `node/`             | `bun/`              | `bun-native/`                     |
| -------------------- | ------------------- | ------------------- | --------------------------------- |
| Package manager      | pnpm                | bun                 | bun                               |
| Bundler / dev server | Vite                | Vite                | **`Bun.serve()` + `Bun.build()`** |
| Tailwind             | `@tailwindcss/vite` | `@tailwindcss/vite` | `bun-plugin-tailwind`             |
| Test runner          | Vitest              | `bun test`          | `bun test`                        |
| Dev-server runtime   | Node                | Node                | **Bun**                           |
| `node_modules`       | 75 MB               | 70 MB               | **57 MB**                         |
| Dev server → 200     | ✓                   | ✓                   | ✓ (HMR + React Fast Refresh)      |
| Unit test (warm)     | 0.45 s              | 0.017 s             | 0.017 s                           |

**Finding:** for a **pure client SPA**, Bun can replace the _entire_ toolchain —
`Bun.serve({ development: { hmr: true } })` for dev (HMR + React Fast Refresh),
`Bun.build()` for production, `bun-plugin-tailwind` for Tailwind, and `bun test`
for units — with **zero Vite / Vitest** and the smallest `node_modules`.

**Caveats:** Bun's HMR API is officially "work in progress"; there is **no Vite
plugin ecosystem** (PWA / SVGR / legacy / visualizer / …); production Tailwind
needs the plugin passed to `Bun.build()` explicitly (`bunfig`'s `[serve.static]`
applies to the dev server only). This applies to the **SPA slot only** — it does
**not** replace the SSR / routing machinery of RR v7 / TanStack / Next.

---

## 4. Bottom line

- **SPA / "Small Tool" slot:** **Vite + React** remains the default (fastest
  startup, best LLM familiarity). Where the Vite plugin ecosystem isn't needed,
  the **bun-native** toolchain is a viable lighter alternative.
- **Fullstack slot:** three-way tie — **Next.js** (max LLM familiarity, heaviest
  dev server), **React Router v7** (lightest-memory dev server, best-balanced),
  **TanStack Start** (mid-weight, signal-graph reactivity, smallest LLM corpus).
- **Runtime:** keep **dev servers on Node**; adopt **`bun test`** for the unit
  loop across every stack (large, low-risk win); use `bun install` for
  install/image-build speed if desired.
