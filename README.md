# riddle — the diary of Tom Riddle, for the reMarkable Paper Pro

Write on the page with your pen. After a pause, the diary **drinks your ink** —
your words fade into the paper — the page thinks for a moment, and an answer
writes itself back in a flowing hand, stroke by stroke, then fades away.

No screen glow, no keyboard, no chat UI. Just ink appearing on paper.

_This is the diary from [the demo](https://x.com/MaximeRivest)._

### 🪄 New to this? Start here

You need a **reMarkable Paper Pro** in developer mode with a launcher installed.
If that sounds like a lot, it isn't — **[remagic](https://github.com/maximerivest/remagic)**
walks you through turning on developer mode and sets up everything with one
command. Come back here, drop riddle in, and start writing to Tom.

Already have xovi + AppLoad? Skip to [Building](#building).

> ⚠️ **This modifies your device.** It runs as root, stops the vendor UI
> (in takeover mode), and drives the e-ink engine directly. It has only been
> tested on a **reMarkable Paper Pro** (ferrari, aarch64, OS 3.26–3.27). It may
> not work on other models or OS versions, and you use it entirely at your own
> risk. Not affiliated with reMarkable AS. Keep SSH access working before you
> install anything — that is your escape hatch.

## How it works

```
 pen (raw evdev, full 4096-level pressure, hardware event rate)
   │ strokes
   ▼
 riddle ── idle 2.8s → commit page → PNG ──► oracle (resident LLM process,
   │                                          streams reply sentence-by-sentence)
   ▼ strokes (Dancing Script → skeletonized to single-pixel pen paths)
 display backend
   ├── qtfb        — windowed, inside xochitl (AppLoad app)
   └── quill       — full takeover: xochitl stopped, vendor e-ink engine
                     driven directly for instant ink (lowest latency there is)
```

- **`riddle/`** — the app (Rust). Pen input, ink surface, handwriting
  synthesis (rasterize → Zhang-Suen thinning → stroke tracing → animated
  replay), the oracle process manager, and both display backends.
- **`quill/`** — the takeover display host (C/C++). An
  [epfb-re](https://github.com/asivery)-style QImage-constructor interposition
  shim over the vendor `libqsgepaper.so` waveform engine, exposed as a small
  C ABI (`quill_init` / `quill_buffer` / `quill_swap`) that riddle links
  against with `--features takeover`. Includes `scribble`, a minimal
  pen-to-glass latency demo.

## Gestures

| Do this | And |
|---------|-----|
| Write, then rest the pen | The diary drinks your ink and Tom replies |
| Flip the marker | Erase |
| Draw a large **?** | Summon the built-in guide |
| Tap five fingers at once | Leave the diary |
| Power button | The page turns to *"The diary sleeps."*, then the tablet suspends; press again to wake exactly where you were |

## The oracle (the "spirit" in the diary)

Replies come from a resident LLM agent process on the device
(`riddle/src/oracle.rs` spawns [`pi`](https://github.com/badlogic/pi-mono) in
RPC mode and keeps it warm, so each turn pays only model latency — first ink
lands ~1.4 s after the page commits). The committed page is sent as an inline
PNG; the model reads your handwriting directly.

You can swap in any backend by editing `oracle.rs`: anything that accepts an
image and streams text back will do. The persona prompt lives in the same file.

## Building

Cross-compiled from x86_64. Two flavours:

### Windowed (AppLoad/qtfb) — easiest

Requires [xovi + AppLoad](https://github.com/asivery/rm-appload) on the device.

```sh
cd riddle
cargo build --release --target aarch64-unknown-linux-gnu
```

Install to `/home/root/xovi/exthome/appload/riddle/` with
`external.manifest.json`, `appload-launch.sh`, and the binary.

### Takeover (instant ink) — the one from the demo

Requires the reMarkable SDK toolchain (`~/rm-sdk-3.26`) because the linked
vendor Qt libs need its glibc, **and** `libqsgepaper.so` pulled from *your own
device* (it is proprietary and not distributed here):

```sh
cd quill && ./build.sh          # pulls libqsgepaper.so from the device over ssh,
                                # builds libquill.so + scribble
cd ../riddle && ./build-takeover.sh
```

Deploy `libquill.so` to `/home/root/quill/` and `riddle-takeover` to
`/home/root/riddle/riddle`, plus `scripts/riddle-takeover.sh`. Launching via
AppLoad (`appload-launch.sh`) detaches into a transient systemd unit, stops
xochitl, runs the diary, and **always restores xochitl on exit** — exit with
the power button, a 5-finger tap, or SIGTERM. If anything wedges:
`ssh root@10.11.99.1 'systemctl start xochitl'`.

## Fonts

The reply hand is [Dancing Script](https://github.com/googlefonts/DancingScript)
(SIL OFL 1.1 — see `riddle/fonts/OFL.txt`).

## License

MIT for everything in this repository (see `LICENSE`). The vendor libraries it
interposes (`libqsgepaper.so`, Qt) are **not** included and must come from
your own device/SDK.
