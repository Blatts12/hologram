# Memoize what a stateful component rendered

Every action re-renders the whole page. On a page of 150 stateful components where one component
took new state, the client still rebuilt all 150 subtrees, and that took about 1.7 ms per action.
This branch lets a component whose inputs did not change hand back what it rendered last time.

This note assumes you know how the client renders. `Renderer.renderPage` walks the compiled
template tree and builds Snabbdom vnodes, and `Vdom.patchVirtualDocument` diffs them against the
previous render.

## What is the issue?

The renderer had no memory between renders. A component whose props, state and context were the
same as last time still called its template closure, built its boxed terms and allocated fresh
vnodes. Snabbdom then diffed that fresh subtree node by node, only to find nothing had changed.

## Why is it a problem?

On a typical page an action changes one component and leaves the rest alone. So nearly all of the
render and diff work goes into subtrees that come out identical. That cost grows with the size of
the page, not with the size of the change.

## How does this branch fix it?

A new module, `assets/js/render_cache.mjs`, stores what each stateful component rendered. When
`Renderer.#renderStatefulComponent` reaches a component with the same inputs, the cache hands back
the very vnode objects it handed back before. Snabbdom's `patchVnode` returns at once when it sees
the same object on both sides. So the saving compounds: no template call, no terms, and the diff
stops at the top of the subtree.

An entry is keyed on everything the component render reads:

- the module
- the merged vars (props and state)
- the merged context
- the slot content
- the parent tag name

The key cannot see a descendant's own state, since an action can change a component deep in the
tree without touching anything its ancestors pass down. `RenderCache.leave` carries each frame's
descendant cids up to the enclosing frame. `RenderCache.markDirty`, called where an action stores a
new component struct, invalidates every entry above that component.

A skipped subtree still has to report its event bindings, or `EventListenerRegistry.reconcile`
would tear down its `<window>` listeners. So an entry keeps the bindings its render collected, and
`Renderer.#replayBindings` puts them back when the entry is served.

The cache is dropped wholesale in three places, all for one reason. An entry's vnodes point at DOM
nodes, and an entry that outlives their page would be served from a state nothing holds.

- `ComponentRegistry.clear` and `ComponentRegistry.populate`
- a change of `Hologram.registryEpoch`, checked by `RenderCache.beginPass`
- a render that raised, caught in the render loop in `hologram.mjs`

The branch has three commits. The first adds the cache. The second fixes a bitstring comparison
inside it. The third adds the benchmark below.

The second commit is worth knowing about on its own. `RenderCache.#isSameValue` first compared
bitstrings by text whenever both sides had one:

```js
return left.text !== null && right.text !== null && left.text === right.text;
```

A bitstring's `text` is `null` until something decodes the bytes, and `false` when the bytes are
not valid UTF-8. Both values pass a `!== null` check. So two different undecodable bitstrings both
read as `false` and compared equal, and a cache hit on that would serve the wrong subtree. The fix
accepts only a real decoded string and also compares `leftoverBitCount`.

## Performance

The new benchmark `benchmarks/javascript/renderer/render_page/deep_change_many_siblings` builds a
page of 50 branches, each three stateful components deep. It prices two cases, with the cache on
and off. You can run it from the repository root:

```sh
node --expose-gc --require ./assets/node_modules/jsdom-global/register.js \
  benchmarks/javascript/renderer/render_page/deep_change_many_siblings/run.mjs
```

These are warm averages, median of three runs on one machine with Node 24.14. Treat the ratios as
meaningful and the absolute microseconds as local.

| Scenario | Cache off | Cache on | Change |
|---|---|---|---|
| One leaf changed | 1737 μs | 316 μs | 5.5x faster |
| Every leaf changed | 1818 μs | 2052 μs | 13% slower |

The first row is what an ordinary action costs. The second row is the price of the cache when
nothing can be skipped.

## Trade-offs

The cache is a loss when every component changes on every action. It keys and stores 150 entries
that are never served, which costs about 13% on this page. If your pages change everything on
every action, the cache works against you.

The cache also holds one entry per component, vnodes included, for as long as the page lives. That
memory is bounded by the page you are on, and it is released on navigation.

A word of caution about the key. It is correct only while `#renderStatefulComponent` reads nothing
beyond the five inputs above. If a future change makes a component's output depend on anything
else, that input has to join the key, or the component has to be kept out of the cache.

This branch is a port from `f-940/local-first`. There, a component with a prop resolved from a
query reads the local database, so it and every component around it skip the cache. `dev` has no
query props, so that part is left out here. It has to come back when local-first lands.
