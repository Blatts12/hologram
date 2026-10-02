# Memoize the JS name an alias encodes to

A render asks for the same handful of modules over and over, once per component it renders. Each
time, `Interpreter.moduleJsName` worked out the module's JS class name from scratch. This branch
remembers the answer.

This note assumes you know that a transpiled Elixir module lives on `globalThis` under a JS class
name derived from its alias, like `Elixir_MyApp_Counter` for `MyApp.Counter`.

## What is the issue?

`Interpreter.moduleJsName` split the alias string, capitalized each segment and joined the result
on every call. The mapping from alias to JS name never changes, but nothing kept it.

## Why is it a problem?

The function sits on the render path. `Interpreter.moduleProxy` calls it for every component on
every render, and five other interpreter lookups call it too. So the same strings were rebuilt
thousands of times per render.

## How does this branch fix it?

The result is cached in a static `Map` keyed by the alias string. The first call for an alias does
the split, capitalize and join. Every later call is one `Map.get`.

## Performance

The numbers are medians of three runs interleaved with `dev`, on one machine with Node 24.14.

| Measurement | `dev` | This branch | Change |
|---|---|---|---|
| `moduleJsName` for one alias | 360 ns | 13 ns | 27x faster |
| Page, one leaf changed | 1653 μs | 1520 μs | 8% faster |
| Page, every leaf changed | 1792 μs | 1633 μs | 9% faster |

The page is `deep_change_many_siblings`, a copy run without the render cache. It renders 150
stateful components per action.

## Trade-offs

The cache holds one string per module the page has touched. That is bounded by the number of
modules in your app, so it cannot grow with your data.
