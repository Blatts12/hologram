# Cache the prop names a component accepts

Each time a component renders, the renderer works out which of its incoming props the component
accepts. It rebuilt that list from the module's prop definitions on every render, then compared
every incoming prop against every declared one. This branch derives the list once per module.

This note assumes you know that `Renderer.#filterAllowedProps` drops any prop a component does not
declare, following `filter_allowed_props/2` on the server.

## What is the issue?

`#filterAllowedProps` did two costly things per render:

- It rebuilt the list of declared prop names from `__props__/0`, boxing each name as a bitstring.
- It matched each incoming prop against that list with `Interpreter.isStrictlyEqual` on boxed
  bitstrings, so the cost was the product of the two counts.

## Why is it a problem?

Which names a component accepts is a property of its module. It never changes between renders.
Yet every component on the page paid for it on every render, and a component with many props paid
the most.

## How does this branch fix it?

`Renderer.#getAllowedPropNames` builds a `Set` of plain text names the first time a module asks
for it. It keeps the set on the module proxy as `__allowedPropNames__`, the same way `__props__`
is already kept. The filter then turns into one `Set.has` per incoming prop.

## Performance

The measurements come from the `deep_change_many_siblings` page, a copy run without the render
cache. It renders 150 stateful components per action. The numbers are medians of three runs
interleaved with `dev`, on one machine with Node 24.14.

| Scenario | `dev` | This branch | Change |
|---|---|---|---|
| One leaf changed | 1653 μs | 1567 μs | 5% faster |
| Every leaf changed | 1792 μs | 1694 μs | 5% faster |

Each benchmark component declares only `cid`. A component that declares more props gains more,
since the old cost grew with both counts.

## Trade-offs

The set lives on the module proxy for as long as the page does. That is one small set per
component module, bounded by the number of modules in your app.

A word of caution for later changes. The set is derived once, so anything that changes a module's
prop definitions at runtime would have to drop `__allowedPropNames__` too. Nothing does that today.
`p/render-walk-per-node` builds on this branch.
