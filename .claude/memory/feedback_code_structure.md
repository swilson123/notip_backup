---
name: feedback-code-structure
description: The one pattern all white_rabbit modules must follow — no exceptions
metadata:
  type: feedback
---

All functions attached to the white_rabbit God variable must use this structure:

```js
var my_function = function (white_rabbit) {
    // all logic here — white_rabbit is the sphere, everything is accessible
};

module.exports = my_function;
```

Called as `white_rabbit.my_function(white_rabbit)`.

For functions needing a reset/init entry point, attach directly on the export:
```js
my_function.start = function () { ... };
```

Module-level variables hold persistent state between calls (`let _snapshot = null;`).

**Why:** Scott thinks in this pattern. It gives the full picture of a module at a glance —
one named function, exported directly. The sphere passing itself to itself.
Factory patterns, class-style init objects, and `.init(white_rabbit)` boot methods
are harder to reason about and break the God variable philosophy.

**How to apply:** Every new module created for white_rabbit uses this structure.
When refactoring existing code, migrate to this form.
See `lib/imu/compass_calibration.js` and `lib/identity/i_am.js` as canonical examples.

**As of 2026-05-30:** 91 modules on white_rabbit all follow this pattern.
The three remaining outliers (memory_watchdog, calculate_bearing, mavlink_messages)
were also migrated to plain objects/functions — prototype chains and `new` removed.
