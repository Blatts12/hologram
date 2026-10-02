# Derive a type's sortable attributes once

A fill of 10,000 rows walked the same type schema 10,000 times, once per row, to find out which
attributes need a sort key. This branch works that out once per type.

This note assumes you know that `Model.computeSortKeys` writes a `<name>_sort` attribute for every
string attribute of a row as it is filed.

This branch is based on `f-940/local-first` at `4364ea157`, not on `dev`. `model.mjs` exists only
on local-first, so the branch cannot land before that work does.

## What is the issue?

`Model.computeSortKeys` called `Object.entries` over the type's attributes for every row. It
skipped the non-string ones and built the `${name}_sort` name each time.

## Why is it a problem?

Which attributes are strings is a property of the type, not of the row. So a fill rebuilt the
same list and the same names once per row. A profile of the fill put 21% of the time in
`computeSortKeys`, and most of that was the schema walk.

## How does this branch fix it?

`Model.#sortedAttributeNames` derives the list of `[name, sortName]` pairs on first use and keeps
it on the model entry. `computeSortKeys` loops over that list.

The list is derived on first use rather than in `Model.entry`. That way a type whose entry has no
attributes still fails where it used to, not on the way in. Since the list lives on the entry,
`Model.reset` drops it with everything else.

## Performance

The numbers come from `benchmarks/javascript/deltas/apply`, medians of three runs interleaved with
the base, on one machine with Node 24.14.

| Benchmark | Base | This branch | Change |
|---|---|---|---|
| `fill_10k_rows` | 33.1 ms | 29.5 ms | 11% faster |
| `patch_frame_50_deltas` | 143.9 μs | 122.7 μs | 15% faster |

## Trade-offs

The cached list holds one pair per string attribute per type. That is bounded by your schema.

A word of caution for later changes. Anything that changes a type's attributes at runtime has to
drop `sortedAttributeNames` from the entry, or go through `Model.reset`. Nothing else does that
today.
