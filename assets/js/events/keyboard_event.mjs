"use strict";

import Type from "../type.mjs";

export default class KeyboardEvent {
  static buildOperationParam(event) {
    return Type.map([
      [Type.atom("alt_key"), Type.atom(event.altKey)],
      [Type.atom("code"), Type.atom(event.code)],
      [Type.atom("ctrl_key"), Type.atom(event.ctrlKey)],
      [Type.atom("key"), Type.atom(event.key)],
      [Type.atom("meta_key"), Type.atom(event.metaKey)],
      [Type.atom("repeat"), Type.atom(event.repeat)],
      [Type.atom("shift_key"), Type.atom(event.metaKey)],
    ]);
  }

  static isEventIgnored(_event) {
    return false;
  }
}
