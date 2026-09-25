# Clear matched vars without deleting the property

The interpreter clears a temporary property off `vars` after every successful pattern match. It
did that with `delete`, and that one delete made every later read of `vars` slower. This branch
sets the property to `null` instead.

This note assumes you know that a transpiled function body reads its variables as properties of
`context.vars`, and that `Interpreter.updateVarsToMatchedValues` copies a match's bindings in from
`vars.__matched__`.

## What is the issue?

`updateVarsToMatchedValues` ended with `delete context.vars.__matched__`. Deleting a property
moves the object into V8's dictionary mode. In that mode each property read is a hash table lookup
instead of a fixed offset.

## Why is it a problem?

`vars` is read far more often than it is cleared. Every variable a clause body mentions is a
property read on it. So the one delete was paid back by every read that followed it, in every
function that matched a pattern.

## How does this branch fix it?

The property is now set to `null`:

```js
Object.assign(context.vars, context.vars.__matched__);
context.vars.__matched__ = null;
```

Nothing in the codebase checks whether `__matched__` is present. It only checks whether it is
truthy, so `null` clears it as completely as the delete did. Two interpreter tests asserted that
the property was absent, and now assert that it is `null`.

## Performance

The numbers are medians of three runs interleaved with `dev`, on one machine with Node 24.14. The
page is `deep_change_many_siblings`, a copy run without the render cache.

| Scenario | `dev` | This branch | Change |
|---|---|---|---|
| One leaf changed | 1653 μs | 1559 μs | 6% faster |
| Every leaf changed | 1792 μs | 1658 μs | 7% faster |

## Trade-offs

The fix costs nothing at runtime, but it does leave a trap. After this change `__matched__` is
always present on `vars` once a match has run. A word of caution to never add a check of the form
`"__matched__" in vars`, because it will now always be true.
