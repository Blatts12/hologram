# Trim what the render walk does per node

A render walks every component and element on the page, and the walk did more work per node than
it needed to. No single function stood out in a profile. The cost was spread across a few helpers
that run once per component, once per children list or once per element. This branch trims each
of them.

This note assumes you know the client render path: `Renderer.#renderComponent` resolves a
component's props, and `Renderer.#renderNodes` and `#renderElement` build its vnodes.

This branch is based on `p/allowed-prop-names-cache`, because `#castProps` below reads the cached
prop names that branch adds. Merge that one first, or merge this one to get both.

## What is the issue?

Four places did repeated work on every render.

- **The props pipeline built arrays it threw away.** `#castProps` built an array and a tuple per
  prop at three separate steps, then handed them to `from_list/1`, which checked every pair again.
  Context and default injection walked every prop definition with keyword list lookups, and each
  built a new props map.
- **Slot expansion ran for components with no slot.** `#expandSlots` rebuilt and flattened the
  whole children tree for every component, whether or not it held a `<slot>`.
- **Each children list built four arrays.** `#renderNodes` chained `filter`, `map`, `flat` and a
  merging `reduce`.
- **Most elements searched for event bindings they did not have.** `#renderElement` walked an
  element's attributes six times. The compiler adds a `$key` to nearly every element, but `$key`
  binds nothing, and most elements bind no event at all.

## Why is it a problem?

All four run for every component or element on every render, including the ones that did not
change. On a page of 150 components the waste adds up to a fifth of the render.

## How does this branch fix it?

Each step now does the smallest thing its input allows.

- `#castProps` is one loop that filters, evaluates and names each prop, then builds the map.
- The props that take context or a default are derived once per module, as `__contextProps__` and
  `__defaultProps__`. Injection writes straight into the map `#castProps` built, so a component
  with neither pays a length check.
- `#expandSlots` runs only when `#containsSlot` finds a `<slot>`, and that check allocates nothing.
- `#renderNodes` is one loop. Text merging moved into `#pushMergingText`, which still matches the
  server's `merge_neighbouring_text_nodes/1`.
- `#hasEventBindings` answers once whether an element binds any event. When it says no, the
  listener map and the three binding collectors are skipped. The Snabbdom `props` object, which was
  always empty, is gone too.

## Performance

The measurements come from the `deep_change_many_siblings` page, a copy run without the render
cache. It renders 150 stateful components per action. The numbers are medians of three runs
interleaved with the base branch, on one machine with Node 24.14.

| Scenario | `dev` | `p/allowed-prop-names-cache` | This branch |
|---|---|---|---|
| One leaf changed | 1653 μs | 1567 μs | 1277 μs |
| Every leaf changed | 1792 μs | 1694 μs | 1382 μs |

This change on its own makes a render 18% faster than its base. Together with the prop names
cache it is 23% faster than `dev`.

## Trade-offs

Two of these changes carry a trap worth knowing about.

- **The props pipeline now mutates in place.** Context and default injection write straight into
  the map `#castProps` built. That is safe only because nothing else holds that map yet. A word of
  caution to never pass a shared or cached map into `#injectPropsFromContext` or
  `#injectDefaultPropValues`.
- **Skipping `#expandSlots` also skips its flatten.** The output stays the same only because
  `#renderNodes` splices nested node lists into their parent as it goes. If that splicing changes,
  the slot skip has to change with it.

The per-module lists also stay on the module proxy for as long as the page lives. That is a few
small arrays per component module.

This branch is a port from `f-940/local-first`. There, the same commit also returns early from
`#injectPropsFromQuery`. `dev` has no query props, so that part is left out here.
