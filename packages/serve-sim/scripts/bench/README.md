# Streaming benchmark

End-to-end latency / fps / bandwidth / CPU for the simulator stream, against
serve-sim builds (local or published) and other tools (e.g. baguette).

How it works (`bench-stream.ts`):

- A stimulus page is served on `--page-port` (default 4180) and opened in the
  simulator's Safari. On command it flips a large centre square red/blue
  (`--flip square`, a typical small UI change) or repaints full-screen noise
  (`--flip noise`, encoder stress), and can animate continuously
  (`--anim scroll` scrolling text rows, `--anim noise`).
- `native-probe.swift` registers SimulatorKit framebuffer callbacks — the
  surface Simulator.app shows — and timestamps the first framebuffer update
  whose centre pixel changed colour. That is the native reference.
- The stream client timestamps every received frame and decodes its centre
  pixel with `frame-decoder.swift` (VideoToolbox/ImageIO), so "first changed
  frame" is exact. `--kind browser` instead drives the real web UI in Chromium
  (playwright-core, headed for hardware WebCodecs) and timestamps canvas paints.
- `overheadMs` = client − native, i.e. the tool's own capture → encode →
  transport (→ decode/paint in browser mode) cost. CPU is the process tree of
  whatever listens on the target port.

```sh
bun run packages/serve-sim/build.ts
cd packages/serve-sim
export UDID=<booted simulator udid>
# one build, all scenarios (ui / noise / tap), AVCC + MJPEG:
scripts/bench/bench-suite.sh branch 4101 /tmp/bench node dist/serve-sim.js
# published version:
scripts/bench/bench-suite.sh v0.1.44 4102 /tmp/bench npx -y serve-sim@0.1.44
# real browser (needs playwright-core; PLAYWRIGHT_CORE=/path/to/index.mjs):
BROWSER=1 SUFFIX=-ui BENCH_ARGS="--flip square --anim scroll" \
  scripts/bench/run-target.sh branch 4101 /tmp/bench node dist/serve-sim.js
# baguette:
scripts/bench/run-baguette.sh ~/src/baguette/Baguette 4150 /tmp/bench
```

Each target runs with a private `TMPDIR`, so other serve-sim sessions on the
machine are unaffected. Avoid ports WebKit refuses (e.g. 4190).
