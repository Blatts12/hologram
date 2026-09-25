# Skip the sort key walk for an ASCII value

When a client connects, it fills its local database, and every string attribute of every row gets
a sort key. A profile of a 10,000 row fill put 29% of the time inside `SortKey`. This branch adds
two fast paths that skip most of that work for the strings real apps store.

This note assumes you know that `SortKey.compute` lowercases, decomposes, strips combining marks,
folds letters and caps the result, and that `lib/hologram/db/sort_key.ex` does the same on the
server.

This branch is based on `f-940/local-first` at `4364ea157`, not on `dev`. `sort_key.mjs` exists
only on local-first, so the branch cannot land before that work does.

## What is the issue?

`SortKey.compute` ran the full pipeline on every string, even a plain ASCII one that no step would
change. Inside it, `SortKey.#isCombiningMark` ran `.some()` over nine codepoint ranges for every
character, and allocated a closure on each call.

## Why is it a problem?

A fill derives a sort key for every string attribute of every row. Names, titles and slugs are
mostly ASCII, so nearly all of that work produced its input unchanged. On a 10,000 row fill it cost
more than any render.

## How does this branch fix it?

Two commits, one per fast path.

- **`SortKey.#isCombiningMark` checks bounds first.** Every combining mark range lies between
  U+0300 and U+FE2F. A codepoint outside those bounds returns `false` before the list is touched,
  and the list walk is now a plain loop with no closure.
- **`SortKey.compute` returns early for ASCII.** Every strip range starts at U+0300 and every
  foldable letter at U+00DF, so neither pass touches anything below U+0080. Each ASCII character is
  also one UTF-8 byte. So an ASCII string is already stripped and folded, and capping it is a
  length check.

## Performance

The numbers come from `benchmarks/javascript/deltas/apply`, medians of three runs interleaved with
the base, on one machine with Node 24.14.

| Benchmark | Base | This branch | Change |
|---|---|---|---|
| `fill_10k_rows` | 33.1 ms | 15.9 ms | 52% faster |
| `fill_10k_rows`, heap retained | 7.1 MB | 2.4 MB | 66% less |
| `patch_frame_50_deltas` | 143.9 μs | 79.3 μs | 45% faster |

## Trade-offs

A word of caution about the server twin. A rule that holds on one tier and not the other sorts a
client's rows differently from the server's, and nothing reports it. These fast paths are
shortcuts, not rule changes, so neither tier moved. That was checked rather than assumed. The new
code ran against the original over 28,838 strings with zero mismatches. The inputs covered every
codepoint below U+2200, the U+FE00 and emoji ranges, Greek, Hebrew, Arabic and CJK, the cap
boundary at 63, 64 and 65 characters, and 20,000 random concatenations of all of it. Re-run that
check before you touch these functions again.

The ASCII path is also a bet on your data. If your ordered-by strings are mostly accented, Greek,
Hebrew or Arabic, every row takes the slow path and gains only the bounds check. Nothing gets
slower, but most of the gain above is not yours.
