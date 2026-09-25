# Adopt a controlled input the browser normalized

A controlled `<input type="color">` fights the pointer. When you drag its picker, every render
writes the value back onto the element, and the picker jumps under your hand. This branch stops
the renderer from writing a value the element already holds in a different spelling.

This note assumes you know that Hologram keeps form inputs controlled. After each patch,
`Renderer.#updateFormInputValue` writes the value from state onto the element.

## What is the issue?

The guard that skips a redundant write compared raw state against what the browser reads back:

```js
if (newValue === element.value) return;
element.value = newValue;
```

That works only when the browser stores a value exactly as it was given. Some input types rewrite
what they are given. A color input lowercases its hex, so state holding `#FF0000` is read back as
`#ff0000`. The two strings never match, and every render writes the value again.

## Why is it a problem?

Each write lands on an element the user may be interacting with. For a color picker that means
the value is reset while you drag, which is how the picker ends up fighting the pointer. The same
applies to any input type that sanitizes its value.

## How does this branch fix it?

The guard now asks the browser what it would store. `Renderer.#normalizeFormInputValue` writes the
new value to a detached input of the same type and reads it back. If that matches what the element
holds, the write is skipped. There is one detached probe per input type, cached in a `Map`, so the
number of probes is bounded by the number of input types.

Only `<input>` elements are probed. A `<select>` normalizes against its own option list, which a
detached probe does not have. Probing one would return the empty string and block every legitimate
write. A `<textarea>` does not normalize at all.

Three tests in `test/javascript/renderer_test.mjs` cover it. A color value that differs only in
case is not written. A color value that really differs is written. A text value that differs only
in case is still written, since a text input does not normalize.

## Performance

This is a bug fix, not a speed change. On the `deep_change_many_siblings` page, a copy run without
the render cache, the branch measured within noise of `dev`: 1674 μs against 1653 μs. That page
has no form inputs. The measurements come from one machine with Node 24.14, median of three runs
interleaved with `dev`.

## Trade-offs

The fast path is unchanged: when the raw strings already match, nothing new runs. The probe only
runs when they differ, and it costs one write and one read on a detached element. For a color
input that is cheaper than the redundant write it replaces, since that write touched an element on
screen.

A word of caution if you add another form element type later. The probe assumes a detached element
of the same type normalizes the same way the one on screen does. That holds for inputs and fails
for anything whose normalization depends on its children, like a select.
