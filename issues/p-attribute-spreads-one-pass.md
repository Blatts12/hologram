# Expand attribute spreads in one pass

Every element the renderer builds goes through `Renderer.#expandAttributeSpreads`, even when it
has no spread. That function walked the attribute list twice and allocated an array per attribute
on the way. This branch walks it once.

This note assumes you know that a template can spread a map into an element's attributes, and
that the renderer expands those spreads before building the vnode.

## What is the issue?

`#expandAttributeSpreads` first scanned the list with `some()` to find out whether any attribute
was a spread. Then it ran `flatMap` over the same list. For a plain attribute, `flatMap` wrapped
the pair in a one-element array only to flatten it away again.

## Why is it a problem?

A spread is the rare case. So on nearly every element the renderer paid for two walks and one
throwaway array per attribute, and that runs once per element on every render.

## How does this branch fix it?

The function is now a single loop. It pushes each plain attribute's pair straight onto the result
and expands a spread in place when it meets one. It remembers whether it saw a spread, so the
dedupe step still runs only when it is needed.

## Performance

The measurements come from the `deep_change_many_siblings` page, a copy run without the render
cache. It has 150 stateful components and a few hundred elements, none with a spread. The numbers
are medians of three runs interleaved with `dev`, on one machine with Node 24.14.

| Scenario | `dev` | This branch | Change |
|---|---|---|---|
| One leaf changed | 1653 μs | 1601 μs | 3% faster |
| Every leaf changed | 1792 μs | 1743 μs | 3% faster |

A word of caution on reading these. Run-to-run noise on this page was about 3%, so the gain is
real but small. It grows with the number of attributes per element.

## Trade-offs

This one has almost no cost. The loop is a few lines longer than the chained version it replaces.
It is worth taking on its own only as part of the wider render work. By itself it will not change
how a page feels.
