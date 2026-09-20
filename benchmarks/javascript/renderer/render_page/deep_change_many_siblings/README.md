Benchmark

Function: Renderer.renderPage()\
Argument: a page of 50 branches, each three stateful components deep, with one leaf taking new
state before every render

What it prices: an action on a page that is mostly unchanged. One component deep in the tree has
new state and every other branch renders what it rendered last time, which is the case component
memoization exists for. The second pair prices the opposite case - every leaf takes new state, so
nothing can be skipped and the cache is pure overhead.

The renderer without memoization is the same code with the render pass left closed, so nothing is
looked up and nothing is stored.

## System

<table>
  <tr>
    <th>Operating System</th>
    <td>CachyOS Linux</td>
  </tr>
  <tr>
    <th>CPU</th>
    <td>AMD Ryzen 7 5800X</td>
  </tr>
  <tr>
    <th>Number of CPU Cores</th>
    <td>16</td>
  </tr>
  <tr>
    <th>RAM</th>
    <td>31 GB</td>
  </tr>
  <tr>
    <th>Elixir Version</th>
    <td>1.20.0</td>
  </tr>
  <tr>
    <th>Erlang/OTP Version</th>
    <td>29</td>
  </tr>
  <tr>
    <th>Node.js Version</th>
    <td>24.20.0</td>
  </tr>
</table>

## Statistics

<table>
  <tr>
    <th></th>
    <th>Without memoization</th>
    <th>With memoization</th>
  </tr>
  <tr>
    <th>One leaf changed, average warm execution time</th>
    <td>1850 μs</td>
    <td>332 μs</td>
  </tr>
  <tr>
    <th>Every leaf changed, average warm execution time</th>
    <td>1870 μs</td>
    <td>2080 μs</td>
  </tr>
</table>

One changed leaf renders 5.6 times faster, saving about 1.5 ms per action. A page where
everything changed pays about 12% more, which is the key comparison and the stored entry for 150
components that nothing is skipped for - roughly 1.5 μs per component.

Read the cold numbers with care. Each pair runs in one process, so the second phase inherits a
warm JIT from the first and its cold reading is not a first render measured from nothing.

## Running

From the `assets` directory, with the DOM shim the client modules expect and the collector
exposed for the heap reading:

```sh
node --expose-gc --require jsdom-global/register ../benchmarks/javascript/renderer/render_page/deep_change_many_siblings/run.mjs
```
