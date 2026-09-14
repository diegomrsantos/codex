# Desktop renderer diagnostic reproductions

These characterization tests make the source hypotheses in
[openai/codex#45497](https://github.com/openai/codex/issues/45497) reproducible.
They execute functions extracted from Codex Desktop 26.908.40834 (build 8881)
with synthetic histories and a deterministic scheduler. They pass when the
audited mechanisms behave as observed; they are not failing regressions for the
reported memory growth, stream stalls or missing messages.

## Run

Use Node 22 or later and the `app.asar` from that desktop build:

```sh
node scripts/renderer-diagnostics/verify-signature-scan.cjs /path/to/app.asar
node scripts/renderer-diagnostics/verify-streaming-retention.cjs /path/to/app.asar
```

On macOS, omitting the archive argument uses the installation at
`/Applications/ChatGPT.app/Contents/Resources/app.asar`. The matching archive is
required even on another platform. These manual diagnostics are not added to
CI, where that desktop artifact is unavailable. No dependencies beyond Node
are required.

The scripts read one archive entry and verify its SHA-256 before extraction:
`737070f94a072d2b4ede9f326e3e1c4142fb82198961251c2e70479b3f926275`.
A different build fails validation rather than silently testing different code.
The scripts use isolated VM contexts with synthetic dependencies, do not start
the app or access its history, and print the paths of small JSON reports in the
system temporary directory. Neither the app bundle nor private incident data
is included here.

## What the checks establish

The signature matrix tests 100, 1,000 and 10,000 items, with and without subagent
calls. Every one of 30 invocations visits all items. Ordinary text changes leave
the signature unchanged in all 24 updates; changing an actual agent status is a
positive control that changes the result.

Nine additional scenarios verify text draining and cleanup, completion ordering,
reasoning summaries, streaming combined with the scan, and retention selection.
For 2,400 characters and 10,000 synthetic history items:

| Mode                       | Updates | Item visits | Characters delivered |
| -------------------------- | ------: | ----------: | -------------------: |
| Ordinary visible streaming |     100 |   1,000,000 |                2,400 |
| Completion requested       |       8 |      80,000 |                2,400 |
| Document hidden            |       1 |      10,000 |                2,400 |

All cases fully drain their buffers and release the scheduled frame and
visibility listener. Reasoning summaries drain in one frame. Two different task
IDs drain in a visible document; the buffer has no input for the selected task.

Retention tests show that active or unfinished tasks are excluded from expiry
after four hours, then become eligible when those same states complete. A
capacity control selects the two oldest of twelve eligible tasks while excluding
twenty active tasks. Selection is exercised; unsubscribe I/O is not.

## Interpretation

The streaming composition explicitly connects the extracted buffer's `onFlush`
to the extracted signature function. Source inspection supports this connection
in the app, but the intervening production notification machinery is not executed.
History views and retention dependencies are synthetic. Tests count work rather
than measuring time, allocation bytes, retained heap or actual notification rate.

The results establish mechanisms that could multiply work or retain histories.
They do not identify the owner of the incident's 2.5 GB footprint, prove a memory
leak, reproduce WebSocket timeouts or test steering durability. No product fix is
included, and no claim is made that these diagnostics should become permanent
product tests without access to the maintained renderer source.
