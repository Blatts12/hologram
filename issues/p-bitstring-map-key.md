# Write a binary's hex without a byte array

Every time the client resolved the hex of a text binary, it first ran `TextEncoder.encode` on the
text. That call allocates a byte array, and it was nearly all the cost. This branch writes the hex
straight from the text instead.

This note assumes you know that a boxed map keys its entries by the string `Type.encodeMapKey`
returns. For a bitstring, that string is its `Bitstring.serialize` form, `b<leftover bits><hex>`.

## What is the issue?

`Bitstring.maybeResolveHex` encoded the text to UTF-8 bytes, then built two hex characters per
byte. The hex is cached on the bitstring, so a binary you reuse pays only once. But a template
builds a fresh binary from its literal on every render.

The binary that pays most often is the component id. `ComponentRegistry` is a boxed map keyed by
`cid`, and each render looks up every component three or four times. While the renderer tests
ran, the client encoded 2396 atom keys and 368 bitstring keys. Nearly every bitstring key was a
`cid` in the registry.

## Why is it a problem?

Each fresh `cid` paid about 600 ns before its first registry lookup. The same hex is also the wire
format, so every text binary the client sends to the server paid it too.

## How does this branch fix it?

A new private function, `Bitstring.#encodeTextAsHex`, walks the UTF-16 code units and writes the
hex of their UTF-8 bytes. It reads each byte's two hex characters from a table of 256 entries, so
nothing gets allocated along the way. A binary that already holds bytes reads the same table.

The new `maybeResolveHex` in `assets/js/bitstring.mjs` picks the path by what the binary holds:

```js
static maybeResolveHex(bitstring) {
  if (bitstring.hex === null) {
    bitstring.hex =
      bitstring.bytes === null
        ? $.#encodeTextAsHex(bitstring.text)
        : $.#encodeBytesAsHex(bitstring.bytes);
  }
}
```

Let's break down the example above:

- A text binary never gets its bytes set here any more. Code that needs the bytes still calls
  `maybeSetBytesFromText`, as before.
- The hex has to match `TextEncoder` byte for byte, because the server reads it. A surrogate pair
  becomes one 4 byte character, and a lone surrogate becomes U+FFFD, as `TextEncoder` writes it.
- A test in `test/javascript/bitstring_test.mjs` checks the output against `TextEncoder` for every
  UTF-8 length and for lone surrogates.

Neither the map key format nor the wire format changes.

## What else was tried?

An earlier version of this branch keyed a binary by its own text, as `bt<length>:<text>`. That made
the lookup faster still, at about 80 ns. But it added a second key format next to the wire format.
It also needed a length prefix to stop composite keys from colliding, and extra handling so a lone
surrogate and U+FFFD got one key. It did nothing for the wire format either.

## Performance

The numbers are medians of three runs interleaved with `dev`, on one machine with Node 24.14. Each
run builds a fresh binary from one of five keys, one of them Polish text.

| Measurement | `dev` | This branch | Change |
|---|---|---|---|
| Map lookup with a fresh binary key | 708 ns | 168 ns | 4x faster |
| `Bitstring.serialize` of a fresh binary | 600 ns | 85 ns | 7x faster |

The page level benchmark from the first version of this note is not in the repo, so it was not
rerun.

## Trade-offs

The branch adds about 50 lines of hand written UTF-8 encoding. It has to keep matching
`TextEncoder`, and only the test above guards that.

The text key from the first attempt was about 90 ns faster per fresh lookup. A hex key is twice as
long, and a fresh key string gets hashed on every lookup. For a page with 150 components, that is
roughly 14 μs per render, and I think one format is worth it.

This speeds up the hex only. `calculateTextByteCount` and `maybeSetBytesFromText` still go through
`TextEncoder`, so code that needs the byte count or the bytes pays as before.
