"use strict";

import Type from "./type.mjs";

export default class ComponentRegistry {
  static entries = Type.map();

  static clear() {
    ComponentRegistry.entries = Type.map();
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

  // The entries a live reload goes on with: the fresh ones the server rendered with the rebuilt
  // code, each component keeping the state it held. A state key the rebuilt init no longer sets is
  // dropped, and a new one starts at its initial value. A component the fresh render made of
  // another module, or made where there was none, is taken as rendered. A component the fresh
  // render did not make, one the old state put on the page, is kept as it was.
  static mergeKeptState(oldEntries, freshEntries) {
    const data = {...oldEntries.data};

    for (const [encodedCid, [cid, freshEntry]] of Object.entries(
      freshEntries.data,
    )) {
      const oldEntry = oldEntries.data[encodedCid]?.[1];

      if (
        !oldEntry ||
        oldEntry.data["atom(module)"][1].value !==
          freshEntry.data["atom(module)"][1].value
      ) {
        data[encodedCid] = [cid, freshEntry];
        continue;
      }

      const oldStruct = oldEntry.data["atom(struct)"][1];

      const state = ComponentRegistry.#keepOldValues(
        freshEntry.data["atom(struct)"][1].data["atom(state)"][1],
        oldStruct.data["atom(state)"][1],
      );

      const struct = {
        type: "map",
        data: {...oldStruct.data, "atom(state)": [Type.atom("state"), state]},
      };

      data[encodedCid] = [
        cid,
        {
          type: "map",
          data: {
            ...oldEntry.data,
            "atom(struct)": [Type.atom("struct"), struct],
          },
        },
      ];
    }

    return {type: "map", data};
  }

  // The fresh map's keys, each holding the old map's value where the old map has the key.
  static #keepOldValues(freshMap, oldMap) {
    const data = {};

    for (const [encodedKey, [key, value]] of Object.entries(freshMap.data)) {
      data[encodedKey] = [key, oldMap.data[encodedKey]?.[1] ?? value];
    }

    return {type: "map", data};
  }

  static populate(entries) {
    ComponentRegistry.entries = entries;
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
