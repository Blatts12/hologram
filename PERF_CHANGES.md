# Client Performance

Two costs a client pays over and over. Every action re-renders the whole page, and on a page of
150 stateful components that was about 1.8 ms. Every client fills its local database on connect,
and 10,000 rows of that was about 35 ms. Five commits cut the first to 178 μs and the second to
6.9 ms. This records what each one changed and what it bought.

This assumes you know two things. The client renderer walks the compiled template tree in
`Renderer.renderPage`, builds Snabbdom vnodes, and diffs them in `Vdom.patchVirtualDocument`. The
data layer files incoming rows through `Deltas.apply` into `LocalDatabase`.

## What the numbers come from

Readings come from the benchmarks under `benchmarks/javascript`, each of which has its own README
covering the machine and the method. Two of them carry most of the figures here.

`renderer/render_page/deep_change_many_siblings` prices a page of 50 branches, three stateful
components deep, with one leaf taking new state before each render.
`deltas/apply/fill_10k_rows` prices the whole-app fill, nine attributes wide, with one attribute
ordered by so a sort key is derived per row.

Run either from the repository root:

```sh
node --expose-gc --require ./assets/node_modules/jsdom-global/register.js \
  benchmarks/javascript/renderer/render_page/deep_change_many_siblings/run.mjs
```

The render figures measure `renderPage` alone. The patch that follows it is measured separately,
under "Where the render loop actually spends its time" below. Everything here comes from one
machine, so treat the ratios as meaningful and the absolute microseconds as local.

## cache-1: component memoization

The renderer had no memory between renders. A component whose inputs had not changed rebuilt its
whole subtree anyway, which on a mostly unchanged page is nearly all of the work.

This commit added `assets/js/render_cache.mjs`, which stores what each stateful component rendered
last time. When a component is reached again with the same inputs, the cache hands back the very
vnode objects it handed back before. Snabbdom's `patchVnode` returns immediately when it sees the
same object on both sides of a diff, so the saving compounds: the template closure is never
called, no boxed terms are built, and the diff stops at the top of the subtree.

An entry is keyed on everything `#renderStatefulComponent` reads to produce its output. That is
the module, the merged vars, the merged context, the slot content and the parent tag name. Two
things that key cannot see are handled separately.

- **A descendant's own state.** An action can change a component deep in the tree without touching
  anything its ancestors pass down. So `RenderCache.leave` propagates each frame's descendant cids
  up to the enclosing frame, and `markDirty` invalidates an entry when any component beneath it
  takes a new struct.
- **A prop resolved from a query.** Such a component reads the local database rather than its key,
  so its output does not follow from its inputs. `RenderCache.poison` marks every frame currently
  on the stack uncacheable, because an enclosing entry standing in for its own subtree would stand
  in for that component too.

The cache is dropped wholesale in three places, all for the same reason. An entry's vnodes point
at DOM nodes, so an entry outliving the page those nodes belong to would be answered from a state
nothing holds. `ComponentRegistry.clear` drops it, a registry epoch change drops it, and a render
that raised drops it.

## cache-2: a bitstring comparison that could read equal for unequal values

Comparing two cached bitstrings used the text form whenever both sides had one:

```js
return left.text !== null && right.text !== null && left.text === right.text;
```

A bitstring's `text` field is `null` until something decodes the bytes, and `false` when those
bytes are not valid UTF-8. Both of those pass a `!== null` check, so two different undecodable
bitstrings both read as `false` and compared equal. A cache hit on that comparison serves the
wrong subtree.

The fix is in `RenderCache.#isSameValue`:

```js
return (
  typeof left.text === "string" &&
  typeof right.text === "string" &&
  left.leftoverBitCount === right.leftoverBitCount &&
  left.text === right.text
);
```

Let us break down what each clause is doing:

- The `typeof` checks accept only a real decoded string, which is what excludes `false`.
- `leftoverBitCount` goes with it because a text bitstring carries no leftover bits. One that does
  is never equal to one that does not, whatever its text says.

This is a correctness fix rather than a speed one, and it costs nothing measurable. It is here
because it is what makes the cache safe to trust.

## cache-3: two strings built on every lookup

With memoization in place, a profile of the remaining work was flat. No single function dominated,
but two entries had no business being in a render at all.

**Map keys were running a UTF-8 encode.** `Type.encodeMapKey` called `Bitstring.serialize` for
every boxed bitstring key, which builds the byte array and then a hex string of two characters per
byte. For a key like `aria-describedby` that is a 32 character string per lookup. Prop names, var
names and context keys are nearly all binaries, so the renderer paid this constantly.

The fix adds `Bitstring.toMapKey`, which keys a byte aligned binary by its own text. A hash table
key never leaves the client, so it only has to tell unequal bitstrings apart.

A word of caution on why this is a separate function rather than a change to `serialize`. That
function is also the wire format `Hologram.Runtime.Deserializer` reads. Changing it in place broke
thirteen serializer and deserializer tests. The two uses can be split only because
`Serializer.serialize` writes maps as `Object.values(value.data)`, which discards the hash table
property names, so a map key never reaches the wire.

**Module names were re-derived per lookup.** `Interpreter.moduleJsName` split an alias string,
capitalized each segment and joined the result, every time it was asked. A render asks for the
same handful of modules once per component. It is now a `Map`, bounded by the number of modules in
the app.

This commit also carries a bug fix that is not about speed but was found while chasing one. A
controlled `<input type="color">` was written to on every render, because the guard in
`Renderer.#updateFormInputValue` compared raw state against a browser normalized readback:

```js
if (newValue === element.value) return;
element.value = newValue;
```

A color input lowercases its hex. State holding `#FF0000` never compares equal to the `#ff0000`
read back, so the comparison failed forever and every render wrote again. Those writes land on an
element the user may be dragging, which is how a color picker ends up fighting the pointer. The
guard now asks the browser what it would store, using a detached input of the same type cached per
type, so the rule holds for any input type that sanitizes its value.

Select and textarea deliberately skip that probe. A select normalizes against its own option list,
which a detached probe does not have, so probing one would return the empty string and suppress
every legitimate write.

## cache-4: four allocations in the hot path

The profile after cache-3 was still flat, so this commit is four separate small changes rather
than one idea.

**`Renderer.#expandAttributeSpreads` walked the attribute list twice.** It scanned for spreads,
then ran a `flatMap` over the same list. A spread is the rare case, so the common path allocated a
one element array per attribute for the flatten to immediately discard. It is now a single loop
that pushes pairs straight onto the result.

**`Renderer.#filterAllowedProps` re-derived the module's prop list on every component render.** It
then matched every incoming prop against every declared one using `isStrictlyEqual` on boxed
bitstrings, which is the product of the two counts. The allowed names are now a `Set` of plain
text cached on the module proxy, following the `__hasQueryProps__` pattern already there.

**`Type.encodeMapKey` rebuilt an `atom(name)` string for every boxed map lookup.** Atoms are now
interned in a `Map`. Only atoms are held this way. A float or integer key is drawn from a range
nothing bounds, so a cache of those would grow with your data rather than with your program.

**`Interpreter.updateVarsToMatchedValues` deleted a property from a hot object.** Deleting moves
the object into V8 dictionary mode, and `vars` is read far more often than it is cleared, because
every variable a clause body mentions is a property read on it. The delete was paid back by every
read that followed. It is now nulled instead.

That last change is the one to be careful with. Nothing in the codebase tests for the property's
presence, only for its truthiness, so `null` clears it as completely as a delete did. Two
interpreter tests asserted the absent property and were updated. If you ever add a check of the
form `"__matched__" in vars`, it will now be wrong.

## Where the render loop actually spends its time

Four commits went into the render without anyone having measured the patch it feeds. That gap is
now closed, and the answer is that the patch is cheap.

| | render | patch | patch share of loop |
|---|---|---|---|
| One leaf changed | 343 μs | 12.8 μs | 4% |
| Every leaf changed | 1563 μs | 319 μs | 17% |

The render figures here are higher than the table above because this page carries a real `<html>`
with a head and a body, which the render-only benchmark does not. The ratio is the point.

Two things follow from this. Optimizing the render was the right half to work on, and Snabbdom is
not a bottleneck. Replacing the vdom library would buy nothing at these proportions.

## cache-5: the connect-time fill

Everything above is about an action. A client also fills its local database on connect, and that
was costing far more than any render: about 35 ms for 10,000 rows, holding 7.1 MB.

A profile put 29% of it inside `SortKey`, across its strip, fold, cap and compute functions.
Another 21% was `Model.computeSortKeys` itself, most of that walking the schema. Four changes
address both.

**`SortKey.compute` now has an ASCII fast path.** Every strip range begins at U+0300 and every
foldable letter at U+00DF, so nothing below U+0080 is touched by either pass. Each ASCII character
is also one UTF-8 byte. So an ASCII string is already its own stripped and folded form, and
capping it is a length check rather than a walk. Names, titles and slugs are mostly ASCII.

**`SortKey.#isCombiningMark` no longer walks its range list for every character.** It ran `.some()`
over nine ranges, allocating a closure per call. Every pinned range lies between U+0300 and
U+FE2F, so a bounds check settles anything outside them before the list is touched.

**`Model.computeSortKeys` walked the schema once per row.** It called `Object.entries` over the
type's attributes to find the string ones, rebuilding the same list 10,000 times for one fill. The
names are now derived once and cached on the model entry, paired with the companion name each sort
key is stored under. The cache lives on the entry, so `Model.reset` drops it along with everything
else.

**`Deltas.#fileRow` and `LocalDatabase.unmarkCarried` allocated per row.** `Object.entries` built a
pair array for every key of every row, and an empty facts array was allocated whether or not the
row had any to-many relationship. `unmarkCarried` built a key string per row to delete from a set
that is empty for the whole of a fill.

A word of caution on the first two. `SortKey` has a twin in `lib/hologram/db/sort_key.ex`, and the
file warns that a rule holding on one tier and not the other sorts a client's rows differently from
the server's, silently. The fast path is a shortcut and not a rule change, so neither tier moved.
That was checked rather than assumed: the new implementation was run against the original over
28,838 strings, covering every codepoint below U+2200, the U+FE00 and emoji ranges, Greek, Hebrew,
Arabic, CJK, the cap boundary at 63, 64 and 65 characters, and 20,000 random concatenations of all
of it. Zero mismatches. Re-run that check before touching these functions again.

## Results

Average warm execution time for a render, in microseconds, at each commit.

| Scenario | cache-2 | cache-3 | cache-4 |
|---|---|---|---|
| One leaf changed, memoization off | 1824 | 1538 | 1142 |
| One leaf changed, memoization on | 323 | 230 | 178 |
| Every leaf changed, memoization off | 1841 | 1515 | 1101 |
| Every leaf changed, memoization on | 2082 | 1660 | 1204 |

The second row is the one that matters. It is what an ordinary action costs, and it is 45% faster
across cache-3 and cache-4, on top of the 5.6x that cache-1 bought over no memoization at all.
Total sampled CPU work in a profile of that benchmark fell from 7315 ms to 4432 ms.

The data layer, before and after cache-5.

| Benchmark | Before | After |
|---|---|---|
| `deltas/apply/fill_10k_rows` | 34.8 ms | 6.9 ms |
| the same fill, heap retained | 7.1 MB | 2.4 MB |
| `deltas/apply/patch_frame_50_deltas` | 149.5 μs | 44.3 μs |

Sampled CPU work in the fill profile fell from 38.9 s to 8.4 s. The render benchmark is unchanged
by cache-5, which is what you would expect, since none of it is on the render path.

## What this costs, and what it does not fix

Memoization is a loss when nothing can be skipped. The fourth row is about 9% slower than the
third, which is the price of keying and storing 150 entries that are never served. The benchmark
prices both cases on purpose. If your pages change everything on every action, cache-1 is working
against you.

The ASCII fast path is a bet on your data. A database whose ordered-by strings are mostly
accented, Greek, Hebrew or Arabic takes the slow path for every row and gains only the bounds
check. Nothing gets slower, but the 80% is not yours.

Three things are measured and still open.

- **The double walk is still there.** `Renderer.decodeTree` builds boxed terms that `renderDom`
  then walks a second time, which is 13.6 MB of terms on the largest page measured. The TODO at
  `renderer.mjs:174` describes collapsing the pair into one walk. That is the largest remaining
  win and the riskiest, because drift between the two walkers shows up as silently rebuilt DOM
  rather than as a failing test.
- **The rest of the render profile is the core walk.** After cache-4 the top entries are
  `#renderNodes` at 8.1%, the garbage collector at 7.1%, `renderDom` at 6.2% and `#renderElement`
  at 4.9%. Those are architectural, not local, and no further micro-optimization will move them
  much.
- **The fill is now dominated by the filing itself.** After cache-5 the top entries are
  `Deltas.#fileRow` at 29%, `Deltas.apply` at 20% and `Deltas.#putRow` at 11%. What is left is
  copying each row into its attributes object and writing it, which is the work the fill exists to
  do rather than overhead around it.

Two notes for whoever picks this up next.

`benchmarks/javascript/query_kernel/run/page_of_5_queries_over_2k_rows` does not run. It raises
`TypeError: Cannot read properties of undefined (reading 'status')` from `QueryKernel.#enumRanks`,
because `entry.enumValues` is undefined. It was left alone here for being off the performance path.
Whether the fault is in the benchmark's `defineModel` helper or in the product is an open question.

One approach that did not work is worth recording, so nobody spends the afternoon again. Hoisting
the `mfa` template string out of the per call path in `Interpreter.#buildElixirFunction` looked
free, since it is read only when profiling is on. Measured across three runs each it was a
wash, at 1120/1130/1112 μs without against 1143/1124/1139 μs with. V8 already elides it.
