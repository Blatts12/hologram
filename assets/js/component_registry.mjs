"use strict";

import RenderCache from "./render_cache.mjs";
import Type from "./type.mjs";

export default class ComponentRegistry {
  static entries = Type.map();

  // The render cache describes the components this registry holds, so it goes wherever they go:
  // an entry whose component is no longer registered cannot be re-rendered, and one whose
  // component came back with a different struct would be answered from a state nothing here holds.
  static clear() {
    ComponentRegistry.entries = Type.map();
    RenderCache.clear();
  }

  // Optimized (mutates next_action field in-place)
  static clearNextAction(cid) {
    const entry = ComponentRegistry.entries.data[Type.encodeMapKey(cid)][1];
    const componentStruct = entry.data["atom(struct)"][1];
    componentStruct.data["atom(next_action)"][1] = Type.nil();
  }

  // null instead of boxed nil is returned by default on purpose, because the function is not used by transpiled code.
  // Deps: [:maps.get/2]
  static getComponentEmittedContext(cid) {
    const componentStruct = ComponentRegistry.getComponentStruct(cid);

    return componentStruct
      ? Erlang_Maps["get/2"](Type.atom("emitted_context"), componentStruct)
      : null;
  }

  // null instead of boxed nil is returned by default on purpose, because the function is not used by transpiled code.
  // Deps: [:maps.get/3]
  static getComponentModule(cid) {
    const entry = ComponentRegistry.getEntry(cid);

    return entry
      ? Erlang_Maps["get/3"](Type.atom("module"), entry, null)
      : null;
  }

  // null instead of boxed nil is returned by default on purpose, because the function is not used by transpiled code.
  // Deps: [:maps.get/2]
  static getComponentState(cid) {
    const componentStruct = ComponentRegistry.getComponentStruct(cid);

    return componentStruct
      ? Erlang_Maps["get/2"](Type.atom("state"), componentStruct)
      : null;
  }

  // null instead of boxed nil is returned by default on purpose, because the function is not used by transpiled code.
  // Deps: [:maps.get/3]
  static getComponentStruct(cid) {
    const entry = ComponentRegistry.getEntry(cid);

    return entry
      ? Erlang_Maps["get/3"](Type.atom("struct"), entry, null)
      : null;
  }

  // null instead of boxed nil is returned by default on purpose, because the function is not used by transpiled code.
  // Deps: [:maps.get/3]
  static getEntry(cid) {
    return Erlang_Maps["get/3"](cid, ComponentRegistry.entries, null);
  }

  // Deps: [:maps.is_key/2]
  static isCidRegistered(cid) {
    return Type.isTrue(Erlang_Maps["is_key/2"](cid, ComponentRegistry.entries));
  }

  // See clear/0 on why the render cache is dropped here as well: this swaps every struct at once,
  // for a page the entries do not describe.
  static populate(entries) {
    ComponentRegistry.entries = entries;
    RenderCache.clear();
  }

  // Optimized (mutates props field in-place)
  static putComponentProps(cid, props) {
    const entry = ComponentRegistry.entries.data[Type.encodeMapKey(cid)][1];
    const componentStruct = entry.data["atom(struct)"][1];
    componentStruct.data["atom(props)"][1] = props;
  }

  // Optimized (mutates entries/struct field in-place)
  static putComponentStruct(cid, componentStruct) {
    ComponentRegistry.entries.data[Type.encodeMapKey(cid)][1].data[
      "atom(struct)"
    ][1] = componentStruct;
  }

  // Optimized (mutates entries field in-place)
  static putEntry(cid, entry) {
    ComponentRegistry.entries.data[Type.encodeMapKey(cid)] = [cid, entry];
  }
}
