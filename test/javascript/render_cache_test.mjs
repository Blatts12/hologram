"use strict";

import {
  assert,
  componentRegistryEntryFixture,
  defineRuntimeGlobals,
  initComponentRegistryEntry,
} from "./support/helpers.mjs";

import {defineLayoutFixture} from "./support/fixtures/layout_fixture.mjs";

import ComponentRegistry from "../../assets/js/component_registry.mjs";
import Hologram from "../../assets/js/hologram.mjs";
import Interpreter from "../../assets/js/interpreter.mjs";
import RenderCache from "../../assets/js/render_cache.mjs";
import Renderer from "../../assets/js/renderer.mjs";
import Type from "../../assets/js/type.mjs";

import vnodeToHtml from "../../assets/node_modules/snabbdom-to-html/index.js";

defineRuntimeGlobals();
defineLayoutFixture();

// What a component subtree is allowed to skip, and what it is not.
//
// Every case here is a page rendered twice with something changed in between (or nothing), and
// what is asserted is object identity: the renderer hands back the vnodes it handed back last
// time exactly when the diff may skip the subtree, and fresh ones when it may not.
describe("RenderCache", () => {
  const PAGE = "Hologram.Test.Fixtures.RenderCache.Page";
  const PARENT = "Hologram.Test.Fixtures.RenderCache.Parent";
  const CHILD = "Hologram.Test.Fixtures.RenderCache.Child";
  const LISTENER = "Hologram.Test.Fixtures.RenderCache.Listener";
  const SIZED = "Hologram.Test.Fixtures.RenderCache.Sized";

  const cid = (name) => Type.bitstring(name);

  const componentNode = (moduleName, cidName, propsDom = []) =>
    Type.tuple([
      Type.atom("component"),
      Type.alias(moduleName),
      Type.list([textProp("cid", cidName), ...propsDom]),
      Type.list(),
    ]);

  // A prop the template writes as text, rebuilt on every render the way a real template rebuilds
  // it - which is why the cache compares a scalar by what it says rather than by identity.
  const textProp = (name, value) =>
    Type.tuple([
      Type.bitstring(name),
      Type.keywordList([[Type.atom("text"), Type.bitstring(value)]]),
    ]);

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

  const defineComponent = (moduleName, propDefinitions, buildNodes) => {
    defineFunction(moduleName, "__props__", 0, (_context) =>
      Type.list(propDefinitions),
    );

    defineTemplate(moduleName, buildNodes);
  };

  const propDefinition = (name, opts = []) =>
    Type.tuple([Type.atom(name), Type.atom("any"), Type.keywordList(opts)]);

  const varText = (vars, name) =>
    Type.tuple([
      Type.atom("expression"),
      Type.tuple([Interpreter.dotOperator(vars, Type.atom(name))]),
    ]);

  const element = (tagName, attrsDom, childrenDom) =>
    Type.tuple([
      Type.atom("element"),
      Type.bitstring(tagName),
      Type.list(attrsDom),
      Type.list(childrenDom),
    ]);

  // The page renders one component of each kind, so a single render exercises them side by side.
  // Redefined before every test, since a test that redefines one of them redefines it for good.
  const defineFixtures = () => {
    defineFunction(PAGE, "__layout_module__", 0, (_context) =>
      Type.atom("Elixir.Hologram.Test.Fixtures.LayoutFixture"),
    );

    defineFunction(PAGE, "__layout_props__", 0, (_context) => Type.list());
    defineFunction(PAGE, "__props__", 0, (_context) => Type.list());

    defineTemplate(PAGE, (_vars) => [
      componentNode(PARENT, "parent"),
      componentNode(LISTENER, "listener"),
    ]);

    // A component with a child of its own, and nothing of the child's in its own vars: this is the
    // shape a parent memo hit would hide a child's state change behind.
    defineComponent(PARENT, [propDefinition("cid")], (vars) => [
      element(
        "div",
        [],
        [varText(vars, "label"), componentNode(CHILD, "child")],
      ),
    ]);

    defineComponent(CHILD, [propDefinition("cid")], (vars) => [
      element("span", [], [varText(vars, "count")]),
    ]);

    // A component whose only input is a prop the page writes, so a test can change what it is
    // given without touching its state.
    defineComponent(
      SIZED,
      [propDefinition("cid"), propDefinition("size")],
      (vars) => [element("div", [], [varText(vars, "size")])],
    );

    // A <window> tag renders to nothing and records a listener binding instead, which a skipped
    // subtree has to put back or the reconcile tears the real listener down.
    defineComponent(LISTENER, [propDefinition("cid")], (_vars) => [
      element(
        "window",
        [
          Type.tuple([
            Type.bitstring("$click"),
            Type.keywordList([
              [
                Type.atom("expression"),
                Type.tuple([
                  Type.list([
                    Type.tuple([Type.atom("text"), Type.atom("my_action")]),
                  ]),
                ]),
              ],
            ]),
            Type.map(),
          ]),
        ],
        [],
      ),
    ]);
  };

  const renderPage = () => Renderer.renderPage(Type.alias(PAGE), Type.map());

  // The vnode a component rendered, found by what it says rather than by walking the document.
  const bodyChildren = (virtualDocument) =>
    virtualDocument.children.find((child) => child.sel === "body").children;

  const putComponent = (cidName, moduleName, state) => {
    ComponentRegistry.putEntry(
      cid(cidName),
      componentRegistryEntryFixture({
        module: Type.alias(moduleName),
        state: state,
      }),
    );
  };

  // What an action does: a new struct in the registry, and the cache told about it.
  const putState = (cidName, state) => {
    const module = ComponentRegistry.getComponentModule(cid(cidName));

    ComponentRegistry.putEntry(
      cid(cidName),
      componentRegistryEntryFixture({module: module, state: state}),
    );

    RenderCache.markDirty(cid(cidName));
  };

  // Snabbdom turns a text child into a vnode of its own, so what an element says is read off it
  // rather than compared as a string.
  const textOf = (elementVnode, index = 0) => elementVnode.children[index].text;

  beforeEach(() => {
    defineFixtures();
    ComponentRegistry.clear();
    Hologram.registryEpoch = 0;
    Renderer.listenerBindings = [];

    initComponentRegistryEntry(cid("page"), Type.alias(PAGE));
    initComponentRegistryEntry(
      cid("layout"),
      Type.alias("Hologram.Test.Fixtures.LayoutFixture"),
    );

    putComponent(
      "parent",
      PARENT,
      Type.map([[Type.atom("label"), Type.bitstring("aaa")]]),
    );

    putComponent(
      "child",
      CHILD,
      Type.map([[Type.atom("count"), Type.integer(1)]]),
    );

    putComponent("listener", LISTENER, Type.map());
  });

  it("returns the same vnodes when nothing the component depends on changed", () => {
    const first = bodyChildren(renderPage());
    const second = bodyChildren(renderPage());

    assert.strictEqual(second[0], first[0]);
  });

  it("re-renders a component whose own state changed", () => {
    const first = bodyChildren(renderPage());

    putState("parent", Type.map([[Type.atom("label"), Type.bitstring("bbb")]]));

    const second = bodyChildren(renderPage());

    assert.notStrictEqual(second[0], first[0]);
    assert.equal(textOf(second[0]), "bbb");
  });

  it("re-renders a component whose descendant's state changed", () => {
    const first = bodyChildren(renderPage());

    assert.equal(textOf(first[0].children[1]), "1");

    // The parent's own vars are untouched: only the child the action targeted has new state.
    putState("child", Type.map([[Type.atom("count"), Type.integer(2)]]));

    const second = bodyChildren(renderPage());

    assert.notStrictEqual(second[0], first[0]);
    assert.equal(textOf(second[0].children[1]), "2");
  });

  it("describes the same document as a render that cached nothing", () => {
    renderPage();

    putState("child", Type.map([[Type.atom("count"), Type.integer(2)]]));

    // One branch re-rendered around a changed child while the listener component was served from
    // the cache, so this render is the mixed case rather than either extreme.
    const cached = vnodeToHtml(renderPage());

    RenderCache.clear();

    assert.equal(cached, vnodeToHtml(renderPage()));
  });

  it("re-renders a component whose props changed", () => {
    let size = "small";

    defineTemplate(PAGE, (_vars) => [
      componentNode(SIZED, "sized", [textProp("size", size)]),
    ]);

    putComponent("sized", SIZED, Type.map());

    const first = bodyChildren(renderPage());
    assert.equal(textOf(first[0]), "small");

    size = "large";

    const second = bodyChildren(renderPage());

    assert.notStrictEqual(second[0], first[0]);
    assert.equal(textOf(second[0]), "large");
  });

  it("puts a skipped subtree's window listener bindings back", () => {
    renderPage();

    assert.equal(Renderer.listenerBindings.length, 1);

    const second = renderPage();

    assert.equal(Renderer.listenerBindings.length, 1);
    assert.equal(Renderer.listenerBindings[0].target, window);

    // The listener component rendered nothing of its own, so its binding is all it contributes -
    // and it is there because it was replayed, not because the subtree ran.
    assert.equal(bodyChildren(second).length, 1);
  });

  it("drops everything when the registry epoch moves", () => {
    const first = bodyChildren(renderPage());

    Hologram.registryEpoch += 1;

    const second = bodyChildren(renderPage());

    assert.notStrictEqual(second[0], first[0]);
  });

  it("drops everything when the registry is repopulated", () => {
    const first = bodyChildren(renderPage());

    ComponentRegistry.populate(ComponentRegistry.entries);

    const second = bodyChildren(renderPage());

    assert.notStrictEqual(second[0], first[0]);
  });
});
