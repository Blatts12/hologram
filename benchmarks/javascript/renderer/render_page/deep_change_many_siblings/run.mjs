"use strict";

import ComponentRegistry from "../../../../../assets/js/component_registry.mjs";
import Interpreter from "../../../../../assets/js/interpreter.mjs";
import RenderCache from "../../../../../assets/js/render_cache.mjs";
import Renderer from "../../../../../assets/js/renderer.mjs";
import Type from "../../../../../assets/js/type.mjs";

import {benchmark} from "../../../support/helpers.mjs";
import {defineRuntimeGlobals} from "../../../../../test/javascript/support/helpers.mjs";

defineRuntimeGlobals();

// What an action costs on a page that is mostly unchanged: one component deep in the tree takes
// new state, and every other branch renders exactly what it rendered before.
//
// The page is SIBLING_COUNT branches of three stateful components each, the innermost of which
// carries the state the action changes. Only one branch has anything new in it, so the other
// branches are what component memoization is there to skip.
const SIBLING_COUNT = 50;

const PAGE = "Hologram.Benchmark.RenderCache.Page";
const LAYOUT = "Hologram.Benchmark.RenderCache.Layout";
const BRANCH = "Hologram.Benchmark.RenderCache.Branch";
const MIDDLE = "Hologram.Benchmark.RenderCache.Middle";
const LEAF = "Hologram.Benchmark.RenderCache.Leaf";

const defineFunction = (moduleName, name, arity, body) => {
  Interpreter.defineElixirFunction(moduleName, name, arity, "public", [
    {params: (_context) => [], guards: [], body: body},
  ]);
};

const defineTemplate = (moduleName, buildNodes) => {
  defineFunction(moduleName, "template", 0, (moduleContext) =>
    Type.anonymousFunction(
      1,
      [
        {
          params: (_context) => [Type.variablePattern("vars")],
          guards: [],
          body: (bodyContext) => Type.list(buildNodes(bodyContext.vars.vars)),
        },
      ],
      moduleContext,
    ),
  );
};

const defineComponent = (moduleName, propNames, buildNodes) => {
  defineFunction(moduleName, "__props__", 0, (_context) =>
    Type.list(
      propNames.map((name) =>
        Type.tuple([Type.atom(name), Type.atom("any"), Type.keywordList()]),
      ),
    ),
  );

  defineTemplate(moduleName, buildNodes);
};

const textAttr = (name, value) =>
  Type.tuple([
    Type.bitstring(name),
    Type.keywordList([[Type.atom("text"), Type.bitstring(value)]]),
  ]);

const element = (tagName, attrsDom, childrenDom) =>
  Type.tuple([
    Type.atom("element"),
    Type.bitstring(tagName),
    Type.list(attrsDom),
    Type.list(childrenDom),
  ]);

const text = (value) => Type.tuple([Type.atom("text"), Type.bitstring(value)]);

const varText = (vars, name) =>
  Type.tuple([
    Type.atom("expression"),
    Type.tuple([Interpreter.dotOperator(vars, Type.atom(name))]),
  ]);

const componentNode = (moduleName, cidName) =>
  Type.tuple([
    Type.atom("component"),
    Type.alias(moduleName),
    Type.list([textAttr("cid", cidName)]),
    Type.list(),
  ]);

defineFunction(PAGE, "__layout_module__", 0, (_context) =>
  Type.atom(`Elixir.${LAYOUT}`),
);

defineFunction(PAGE, "__layout_props__", 0, (_context) => Type.list());
defineFunction(PAGE, "__props__", 0, (_context) => Type.list());

defineTemplate(PAGE, (_vars) =>
  Array.from({length: SIBLING_COUNT}, (_item, index) =>
    componentNode(BRANCH, `branch_${index}`),
  ),
);

defineComponent(LAYOUT, ["cid"], (_vars) => [
  element("div", [textAttr("class", "layout")], [element("slot", [], [])]),
]);

defineComponent(BRANCH, ["cid"], (vars) => [
  element(
    "section",
    [textAttr("class", "branch")],
    [
      element("h2", [], [varText(vars, "title")]),
      componentNode(MIDDLE, `middle_${varTextValue(vars, "index")}`),
    ],
  ),
]);

defineComponent(MIDDLE, ["cid"], (vars) => [
  element(
    "div",
    [textAttr("class", "middle")],
    [
      element("p", [], [text("middle of "), varText(vars, "title")]),
      componentNode(LEAF, `leaf_${varTextValue(vars, "index")}`),
    ],
  ),
]);

// The leaf does the work a real component does: a handful of elements with attributes, and a
// value of its own in the middle of them.
defineComponent(LEAF, ["cid"], (vars) => [
  element(
    "ul",
    [textAttr("class", "leaf")],
    Array.from({length: 5}, (_item, index) =>
      element(
        "li",
        [textAttr("class", `item_${index}`), textAttr("id", `leaf_${index}`)],
        [text("count = "), varText(vars, "count")],
      ),
    ),
  ),
]);

// The cid a component's own child is named by, read out of the component's state rather than
// built from the template, since a benchmark component has no props to pass down.
function varTextValue(vars, name) {
  return Renderer.toText(
    vars.data[Type.encodeMapKey(Type.atom(name))]?.[1] ?? Type.bitstring(""),
  );
}

const componentEntry = (moduleName, state) =>
  Type.map([
    [Type.atom("module"), Type.alias(moduleName)],
    [Type.atom("struct"), Type.componentStruct({state: state})],
  ]);

const branchState = (index) =>
  Type.map([
    [Type.atom("index"), Type.bitstring(String(index))],
    [Type.atom("title"), Type.bitstring(`Branch ${index}`)],
  ]);

const populateRegistry = () => {
  ComponentRegistry.clear();

  ComponentRegistry.putEntry(
    Type.bitstring("page"),
    componentEntry(PAGE, Type.map()),
  );

  ComponentRegistry.putEntry(
    Type.bitstring("layout"),
    componentEntry(LAYOUT, Type.map()),
  );

  for (let index = 0; index < SIBLING_COUNT; index += 1) {
    ComponentRegistry.putEntry(
      Type.bitstring(`branch_${index}`),
      componentEntry(BRANCH, branchState(index)),
    );

    ComponentRegistry.putEntry(
      Type.bitstring(`middle_${index}`),
      componentEntry(MIDDLE, branchState(index)),
    );

    ComponentRegistry.putEntry(
      Type.bitstring(`leaf_${index}`),
      componentEntry(LEAF, Type.map([[Type.atom("count"), Type.integer(0)]])),
    );
  }
};

let count = 0;

// What an action does before the render it triggers: one component's struct is replaced, and the
// cache is told which component that was.
const changeOneLeaf = () => {
  count += 1;

  const cid = Type.bitstring("leaf_0");

  ComponentRegistry.putEntry(
    cid,
    componentEntry(LEAF, Type.map([[Type.atom("count"), Type.integer(count)]])),
  );

  RenderCache.markDirty(cid);
};

// The other extreme: every leaf takes new state, so nothing is skipped and the cache is pure
// overhead - one key comparison and one entry stored per component, for nothing. This is what a
// page where everything really did change pays.
const changeEveryLeaf = () => {
  count += 1;

  for (let index = 0; index < SIBLING_COUNT; index += 1) {
    const cid = Type.bitstring(`leaf_${index}`);

    ComponentRegistry.putEntry(
      cid,
      componentEntry(
        LEAF,
        Type.map([[Type.atom("count"), Type.integer(count)]]),
      ),
    );

    RenderCache.markDirty(cid);
  }
};

const renderOnce = () => {
  changeOneLeaf();
  Renderer.renderPage(Type.alias(PAGE), Type.map());
};

const renderEverythingChanged = () => {
  changeEveryLeaf();
  Renderer.renderPage(Type.alias(PAGE), Type.map());
};

const beginPass = RenderCache.beginPass;

// The cache is bypassed by leaving the pass closed: nothing is looked up and nothing is stored,
// which is the renderer as it was before memoization.
const withoutCache = (fun) => {
  RenderCache.beginPass = () => {};
  populateRegistry();
  benchmark(fun);
  RenderCache.beginPass = beginPass;
};

const withCache = (fun) => {
  RenderCache.beginPass = beginPass;
  populateRegistry();
  benchmark(fun);
};

console.log(`Siblings: ${SIBLING_COUNT}, stateful components per branch: 3`);

console.log("\nOne leaf changed, without component memoization:");
withoutCache(renderOnce);

console.log("\nOne leaf changed, with component memoization:");
withCache(renderOnce);

console.log("\nEvery leaf changed, without component memoization:");
withoutCache(renderEverythingChanged);

console.log("\nEvery leaf changed, with component memoization:");
withCache(renderEverythingChanged);
