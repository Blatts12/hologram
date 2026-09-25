# Intern the map key an atom encodes to

Every boxed map lookup turns its key into a string first. For an atom that string is
`atom(name)`, and it was built again on every lookup. This branch builds it once per atom.

This note assumes you know that a boxed map keeps its entries in `map.data`, keyed by the string
`Type.encodeMapKey` returns.

## What is the issue?

`Type.encodeMapKey` built `atom(${term.value})` with a template string on every call. Every vars
map, props map and context map in a render is keyed by atoms, so a render asks for the same few
keys thousands of times.

## Why is it a problem?

A freshly built string is a new object. Before V8 can use it as a property name it has to flatten
and hash it, and that work is thrown away after the lookup. A string that has been used before
keeps its hash, so a lookup with it is much cheaper.

## How does this branch fix it?

`Type.#encodeAtomMapKey` keeps a static `Map` from atom name to its key string. The first lookup
for an atom builds the string. Every later lookup hands back the same string object.

## Performance

The numbers are medians of four runs interleaved with `dev`, on one machine with Node 24.14.

| Measurement | `dev` | This branch | Change |
|---|---|---|---|
| Map lookup with a fresh atom key | 61 ns | 20 ns | 3x faster |
| Page, one leaf changed | 1653 μs | 1525 μs | 8% faster |
| Page, every leaf changed | 1784 μs | 1632 μs | 9% faster |

The page is `deep_change_many_siblings`, a copy run without the render cache. It renders 150
stateful components per action.

A word of caution on measuring this. `encodeMapKey` alone, called with one constant atom, looks
slower here: 10 ns against 4 ns on `dev`. With a single constant, V8 already reuses the built
string, so the `Map` lookup is pure overhead. The gain only shows once the key is used for a
lookup, which is the only thing a map key is for.

## Trade-offs

The cache holds one string per atom the page has used as a map key. Atoms are bounded by your
program, so the cache is too.

Only atoms are interned. A float or integer key comes from a range nothing bounds, so caching
those would grow with your data rather than with your program.
