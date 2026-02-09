"use strict";

import PointerEvent from "./pointer_event.mjs";

export default class ClickAwayEvent {
  static buildOperationParam(event) {
    return PointerEvent.buildOperationParam(event);
  }

  static isEventIgnored(event) {
    return false;
  }
}
