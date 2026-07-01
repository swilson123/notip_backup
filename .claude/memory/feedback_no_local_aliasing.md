---
name: feedback-no-local-aliasing
description: Don't alias white_rabbit fields into local variables just to shorten access
metadata:
  type: feedback
---

Never write `var _pd = white_rabbit.realsense.path_detection;` (or similar) purely to shorten
access. Reference `white_rabbit.x.y.z` directly at every use site, even when repeated many
times in one function.

A local variable is fine ONLY when it holds a genuinely *computed* value — a confidence-gated
result, a fallback-defaulted config lookup, an accumulated bias. Never when it's a pure rename
of something already reachable on white_rabbit.

**Why:** Scott moves code between functions and files constantly. An alias only exists inside
the function that declared it, so pasted code silently breaks or shadows a different variable —
while `white_rabbit.x.y.z` works unchanged wherever it lands. This is the same God-variable
principle as [[feedback_code_structure]] (don't duplicate state that already lives on the
sphere) applied to read access, not just structure.

**How to apply:** When writing or reviewing any white_rabbit module, if a `var` is just
`white_rabbit.some.nested.path` with no transformation, delete the local var and reference the
full path directly at each call site.

**Caught 2026-07-01:** `lib/yellow_brick_road/carrot.js` had `var _pd =
white_rabbit.realsense.path_detection;` — pure aliasing, removed in favor of the direct path.
Also see [`../../CLAUDE.md`](../../CLAUDE.md) Standing rules, same date.
