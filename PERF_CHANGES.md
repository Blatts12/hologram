# Client Performance

A client pays two costs over and over. Every action re-renders the whole page, and on a page of 150
stateful components that took about 1.8 ms. Every client also fills its local database on connect,
and 10,000 rows of that took about 35 ms. The work recorded here cut the first to 156 μs and the
second to 6.9 ms.

The changes are grouped by what they do rather than by when they landed. Each section says what
was slow, why, and what the benchmarks said afterwards. The costs and the open questions come last.

This guide assumes you know two things. The client renderer walks the compiled template tree in
`Renderer.renderPage`, builds Snabbdom vnodes, and diffs them in `Vdom.patchVirtualDocument`. The
data layer files incoming rows through `Deltas.apply` into `LocalDatabase`.

## Where do the numbers come from?

Readings come from the benchmarks under `benchmarks/javascript`, and each one has a README covering
the machine and the method. Two of them carry most of the figures here.

- `renderer/render_page/deep_change_many_siblings` prices a page of 50 branches, three stateful
  components deep, with one leaf taking new state before each render.
- `deltas/apply/fill_10k_rows` prices the whole-app fill. Rows are nine attributes wide, and one
  attribute is ordered by, so a sort key is derived per row.

You can run either one from the repository root. This is the render benchmark:

```sh
node --expose-gc --require ./assets/node_modules/jsdom-global/register.js \
  benchmarks/javascript/renderer/render_page/deep_change_many_siblings/run.mjs
```

The render figures measure `renderPage` alone. The patch that follows it is measured separately,
under "How is the render loop split?" below. Everything here comes from one machine, so treat the
ratios as meaningful and the absolute microseconds as local.

## Rendering: skipping unchanged components

The renderer had no memory between renders. A component whose inputs had not changed rebuilt its
whole subtree anyway, and on a mostly unchanged page that is nearly all of the work.

`assets/js/render_cache.mjs` stores what each stateful component rendered last time. When a
component is reached again with the same inputs, the cache hands back the very vnode objects it
handed back before. Snabbdom's `patchVnode` returns immediately when it sees the same object on
both sides of a diff. So the saving compounds. The template closure is never called, no boxed terms
are built, and the diff stops at the top of the subtree.

An entry is keyed on everything `#renderStatefulComponent` reads to produce its output. That is the
module, the merged vars, the merged context, the slot content and the parent tag name. The key
cannot see two things, so they are handled separately.

- **A descendant's own state.** An action can change a component deep in the tree without touching
  anything its ancestors pass down. So `RenderCache.leave` propagates each frame's descendant cids
  up to the enclosing frame, and `markDirty` invalidates an entry when any component beneath it
  takes a new struct.
- **A prop resolved from a query.** Such a component reads the local database rather than its key,
  so its output does not follow from its inputs. `RenderCache.poison` marks every frame on the
  stack uncacheable. An enclosing entry standing in for its own subtree would otherwise stand in for
  that component too.

The cache is dropped wholesale in three places, all for one reason. An entry's vnodes point at DOM
nodes, and an entry that outlives their page would be answered from a state nothing holds. So
`ComponentRegistry.clear` drops it, a registry epoch change drops it, and a render that raised
drops it.

Memoization alone made the ordinary action 5.6x faster than rendering everything.

## Rendering: less work per node

With memoization in place, what is left is the walk itself: the components and elements that do
render. No single function dominated the profile, so these are several small changes to code that
runs once per node.

**Attribute spreads were walked twice.** `Renderer.#expandAttributeSpreads` scanned for spreads,
then ran a `flatMap` over the same list. A spread is the rare case, so the common path allocated a
one-element array per attribute for the flatten to throw away. It is now a single loop that pushes
pairs straight onto the result.

**Allowed prop names were re-derived per component.** Each render rebuilt the module's prop list,
then matched every incoming prop against every declared one with `isStrictlyEqual` on boxed
bitstrings. The allowed names are now a `Set` of plain text cached on the module proxy as
`__allowedPropNames__`.

**Each children list built four arrays.** `#renderNodes` chained `filter`, `map`, `flat` and a
merging `reduce`, and it runs once per children list. It is now one loop. Text merging moved into
`#pushMergingText`, which still matches the server's `merge_neighbouring_text_nodes/1`.

**The props pipeline ran in full before the cache lookup.** A component served from the cache still
has its props resolved first, because props are part of the key. That pipeline did a lot per
render.

- `#castProps` built an array and a tuple per prop at three separate steps, then handed them to
  `from_list/1`, which checked every pair again. It is now one loop.
- Context and default injection walked every prop definition with keyword list lookups on every
  render. The props that take context or a default are now derived once per module, as
  `__contextProps__` and `__defaultProps__`. A component with none of either pays a length check.
- `#injectPropsFromQuery` cloned the props map even for a component with no query props. It now
  returns early.
- `#expandSlots` rebuilt the whole children tree and flattened it for every component. It now runs
  only when `#containsSlot` finds a `<slot>`, which an allocation-free walk answers.

**Most elements collected event bindings they did not have.** `#renderElement` walked an element's
attributes six times: attributes, listeners, slot key, and three binding collectors. The compiler
appends a `$key` to nearly every element, but `$key` binds nothing, and most elements bind no event
at all. `#hasEventBindings` now answers that once, and the listener map and the three collectors
are skipped when it says no. The Snabbdom `props` object, which was always empty, is gone too.

The walk changes that came last moved the benchmark as follows.

| Scenario | Before | After |
|---|---|---|
| One leaf changed, memoization off | 1118 μs | 795 μs |
| One leaf changed, memoization on | 177 μs | 156 μs |
| Every leaf changed, memoization off | 1076 μs | 779 μs |
| Every leaf changed, memoization on | 1187 μs | 896 μs |

The props pipeline and `#renderNodes` account for most of that. The event binding skip accounts for
the rest.

## Runtime: lookups repeated on every render

Some of the remaining cost was not in the renderer at all. It was in helpers the renderer calls
constantly, each rebuilding a string it had already built.

**Map keys ran a UTF-8 encode.** `Type.encodeMapKey` called `Bitstring.serialize` for every boxed
bitstring key. That builds the byte array, then a hex string of two characters per byte, so
`aria-describedby` became a 32 character string per lookup. Prop names, var names and context keys
are nearly all binaries, so this was paid constantly. `Bitstring.toMapKey` now keys a byte-aligned
binary by its own text. A hash table key never leaves the client, so it only has to tell unequal
bitstrings apart.

A word of caution on why that is a separate function rather than a change to `serialize`. That
function is also the wire format `Hologram.Runtime.Deserializer` reads, and changing it in place
broke thirteen serializer and deserializer tests. The two uses can be split only because
`Serializer.serialize` writes maps as `Object.values(value.data)`. That discards the hash table
property names, so a map key never reaches the wire.

**Atom keys were rebuilt per lookup.** `Type.encodeMapKey` built an `atom(name)` string for every
boxed map lookup. Atoms are now interned in a `Map`. Only atoms are held this way. A float or
integer key comes from a range nothing bounds, so caching those would grow with your data rather
than with your program.

**Module names were re-derived per lookup.** `Interpreter.moduleJsName` split an alias string,
capitalized each segment and joined the result every time. A render asks for the same handful of
modules once per component. The result is now cached in a `Map`, bounded by the number of modules
in the app.

**A hot object had a property deleted.** `Interpreter.updateVarsToMatchedValues` deleted a property
from `vars`. Deleting moves an object into V8 dictionary mode, and `vars` is read far more often
than it is cleared, since every variable a clause body mentions is a read on it. The property is
now nulled instead.

That last change is the one to be careful with. Nothing in the codebase checks the property's
presence, only its truthiness, so `null` clears it as completely as a delete did. Two interpreter
tests asserted the absent property and were updated. A word of caution to never add a check of the
form `"__matched__" in vars`, because it will now be wrong.

## Data layer: the connect-time fill

Everything above is about an action. A client also fills its local database on connect, and that
cost far more than any render: about 35 ms for 10,000 rows, holding 7.1 MB.

A profile put 29% of it inside `SortKey`, across its strip, fold, cap and compute functions.
Another 21% was `Model.computeSortKeys` itself, mostly walking the schema. Four changes address
both.

- **`SortKey.compute` has an ASCII fast path.** Every strip range begins at U+0300 and every
  foldable letter at U+00DF, so nothing below U+0080 is touched by either pass. Each ASCII
  character is also one UTF-8 byte. So an ASCII string is already stripped and folded, and capping
  it is a length check. Names, titles and slugs are mostly ASCII.
- **`SortKey.#isCombiningMark` no longer walks its ranges for every character.** It ran `.some()`
  over nine ranges and allocated a closure per call. Every range lies between U+0300 and U+FE2F, so
  a bounds check settles anything outside them first.
- **`Model.computeSortKeys` walked the schema once per row.** It called `Object.entries` over the
  type's attributes to find the string ones, 10,000 times for one fill. The names are now derived
  once and cached on the model entry, so `Model.reset` drops them with everything else.
- **`Deltas.#fileRow` and `LocalDatabase.unmarkCarried` allocated per row.** `Object.entries` built
  a pair array for every key of every row. An empty facts array was allocated even for rows with no
  to-many relationship. `unmarkCarried` built a key string per row to delete from a set that stays
  empty for the whole fill.

A word of caution on the `SortKey` changes. It has a twin in `lib/hologram/db/sort_key.ex`, and a
rule that holds on one tier and not the other sorts a client's rows differently from the server's,
silently. The fast path is a shortcut, not a rule change. That was checked rather than assumed. The
new implementation ran against the original over 28,838 strings with zero mismatches. The inputs
covered every codepoint below U+2200, the U+FE00 and emoji ranges, Greek, Hebrew, Arabic and CJK.
They also covered the cap boundary at 63, 64 and 65 characters, and 20,000 random concatenations of
all of it. Re-run that check before you touch these functions again.

## Correctness fixes found along the way

Two bugs surfaced while chasing speed. Neither is about performance, and neither costs anything
measurable.

**A cached bitstring comparison could read equal for unequal values.** `RenderCache.#isSameValue`
first compared bitstrings by their text whenever both sides had one. This was the check:

```js
return left.text !== null && right.text !== null && left.text === right.text;
```

A bitstring's `text` is `null` until something decodes the bytes, and `false` when they are not
valid UTF-8. Both pass a `!== null` check, so two different undecodable bitstrings both read as
`false` and compared equal. A cache hit on that comparison serves the wrong subtree. The fix in
`RenderCache.#isSameValue` reads like this:

```js
return (
  typeof left.text === "string" &&
  typeof right.text === "string" &&
  left.leftoverBitCount === right.leftoverBitCount &&
  left.text === right.text
);
```

Let's break down the example above:

- The `typeof` checks accept only a real decoded string, which is what excludes `false`.
- `leftoverBitCount` goes with it because a text bitstring carries no leftover bits. One that does
  is never equal to one that does not, whatever its text says.

This fix is what makes the render cache safe to trust.

**A controlled color input was written on every render.** The guard in
`Renderer.#updateFormInputValue` compared raw state against what the browser reads back:

```js
if (newValue === element.value) return;
element.value = newValue;
```

A color input lowercases its hex. State holding `#FF0000` never equals the `#ff0000` read back, so
every render wrote the value again. Those writes land on an element the user may be dragging, which
is how a color picker ends up fighting the pointer. The guard now asks the browser what it would
store, using a detached input of the same type cached per type. That holds for any input type that
sanitizes its value.

Select and textarea deliberately skip that probe. A select normalizes against its own option list,
which a detached probe does not have. Probing one would return the empty string and block every
legitimate write.

## How is the render loop split?

The render work above went in before anyone had measured the patch it feeds. That gap is closed,
and the answer is that the patch is cheap.

| | render | patch | patch share of loop |
|---|---|---|---|
| One leaf changed | 343 μs | 12.8 μs | 4% |
| Every leaf changed | 1563 μs | 319 μs | 17% |

These render figures are higher than the other tables because this page carries a real `<html>`
with a head and a body, which the render-only benchmark does not. The ratio is the point. It was
taken before the walk changes, which only shrink the render side, so the patch share has only grown
since.

Two things follow. The render was the right half to work on, and Snabbdom is not a bottleneck.
Replacing the vdom library would buy nothing at these proportions.

## Results

This is the average warm execution time for a render, from memoization alone to today.

| Scenario | Memoization alone | Now |
|---|---|---|
| One leaf changed, memoization off | 1824 μs | 795 μs |
| One leaf changed, memoization on | 323 μs | 156 μs |
| Every leaf changed, memoization off | 1841 μs | 779 μs |
| Every leaf changed, memoization on | 2082 μs | 896 μs |

The second row is the one that matters, since it is what an ordinary action costs. It is 52%
faster than memoization alone, which was itself 5.6x faster than no memoization. Total sampled CPU
work in a profile of that benchmark fell from 7315 ms to 3457 ms.

The data layer moved as follows.

| Benchmark | Before | After |
|---|---|---|
| `deltas/apply/fill_10k_rows` | 34.8 ms | 6.9 ms |
| the same fill, heap retained | 7.1 MB | 2.4 MB |
| `deltas/apply/patch_frame_50_deltas` | 149.5 μs | 44.3 μs |

Sampled CPU work in the fill profile fell from 38.9 s to 8.4 s. None of the fill changes are on the
render path, so the render benchmark did not move with them.

## What was measured and dropped?

Two changes looked free and turned out to be a wash. They are recorded so nobody spends the
afternoon again.

- **Hoisting the `mfa` template string** out of the per-call path in
  `Interpreter.#buildElixirFunction`. It is read only when profiling is on. Across three runs each
  it measured 1120/1130/1112 μs without against 1143/1124/1139 μs with. V8 already elides it.
- **Hoisting constant atoms** such as `Type.atom("cid")` and `Type.atom("default")` out of the
  component render path. It measured 795/157 μs without against 794/156 μs with, for the
  memoization-off and memoization-on single leaf cases. V8 handles those small allocations well,
  so the change was reverted.

## What this costs, and what is still open

Memoization is a loss when nothing can be skipped. The fourth row of the results is now about 15%
slower than the third, which is the price of keying and storing 150 entries that are never served.
That share grew as the walk got cheaper, because the keying cost did not shrink with it. If your
pages change everything on every action, memoization works against you.

The ASCII fast path is a bet on your data. A database whose ordered-by strings are mostly accented,
Greek, Hebrew or Arabic takes the slow path for every row and gains only the bounds check. Nothing
gets slower, but the 80% is not yours.

Two of the walk changes carry a trap worth knowing about.

- **The props pipeline now mutates in place.** Context and default injection write straight into
  the map `#castProps` built. That is safe only because nothing else holds that map yet. A word of
  caution to never pass a shared or cached map into `#injectPropsFromContext` or
  `#injectDefaultPropValues`.
- **Skipping `#expandSlots` also skips its flatten.** That renders the same vnodes only because
  `#renderNodes` splices nested node lists into their parent as it goes. If that splicing ever
  changes, the slot skip has to change with it.

Four things are measured and still open.

- **The double walk is still there.** `Renderer.decodeTree` builds boxed terms that `renderDom` then
  walks a second time, which is 13.6 MB of terms on the largest page measured. The TODO on
  `decodeTree` in `renderer.mjs` describes collapsing the pair into one walk. It is the largest
  remaining win and the riskiest, since drift between the two walkers shows up as silently rebuilt
  DOM rather than a failing test.
- **The render profile is flat.** The top entries are the garbage collector at 7.6%, `maps.get/3`
  at 4.1%, `#pushMergingText` at 3.4% and `#renderNodes` at 3.0%. What is left is the core walk,
  and further micro-optimization will not move it much.
- **The fill is dominated by the filing itself.** The top entries are `Deltas.#fileRow` at 29%,
  `Deltas.apply` at 20% and `Deltas.#putRow` at 11%. That is copying each row into its attributes
  object and writing it, the work the fill exists to do.
- **`benchmarks/javascript/query_kernel/run/page_of_5_queries_over_2k_rows` does not run.** It
  raises `TypeError: Cannot read properties of undefined (reading 'status')` from
  `QueryKernel.#enumRanks`, because `entry.enumValues` is undefined. The fault may be in the
  benchmark's `defineModel` helper or in the product.

One smaller issue is outside the performance path. `#injectPropsFromQuery` clones props with
`Utils.shallowCloneObject`, which shares `.data` with the original. So a query's arguments could
see what an earlier query wrote, which its comment says cannot happen. The build refuses such a
binding today, so nothing breaks, but the guarantee holds by the build check alone.
