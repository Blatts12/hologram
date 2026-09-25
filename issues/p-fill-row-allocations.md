# File a row without allocating per key

Filing one row allocated a small array for every key of the row, an empty list for relationships
it did not have, and a string to unmark it from a set that was empty. One row barely notices. A
fill of 10,000 rows pays all three 10,000 times. This branch drops them.

This note assumes you know that `Deltas.apply` files incoming rows through `Deltas.#fileRow` into
`LocalDatabase`.

This branch is based on `f-940/local-first` at `4364ea157`, not on `dev`. `deltas.mjs` and
`local_database.mjs` exist only on local-first, so the branch cannot land before that work does.

## What is the issue?

Three allocations happened per row whether or not they were needed.

- `Deltas.#fileRow` walked the row with `Object.entries`, which builds a two-element array per key.
- It allocated a `facts` array for to-many relationships, even for rows that have none.
- `LocalDatabase.unmarkCarried` built a `type + separator + id` key string to delete from a set
  that stays empty for the whole fill.

## Why is it a problem?

A fill files every row it carries, and most rows hold plain attributes. So nearly all of these
arrays and strings were built only to be thrown away. That work also feeds the garbage collector
during the fill.

## How does this branch fix it?

Two commits.

- `#fileRow` walks `Object.keys` and reads each value by key. It creates the `facts` array on the
  first to-many relationship it meets, and returns early when there is none.
- `unmarkCarried` returns at once when the carried set is empty, before building the key.

## Performance

The numbers come from `benchmarks/javascript/deltas/apply`, medians of three runs interleaved with
the base, on one machine with Node 24.14.

| Benchmark | Base | This branch | Change |
|---|---|---|---|
| `fill_10k_rows` | 33.1 ms | 28.6 ms | 14% faster |
| `patch_frame_50_deltas` | 143.9 μs | 127.5 μs | 11% faster |

## Trade-offs

These changes have no runtime cost. The code is a few lines longer, and `#fileRow` now has an early
return. Put new work that must run for every row before that return, not after it.
