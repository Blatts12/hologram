"use strict";

import Type from "./type.mjs";

// What a stateful component rendered last time, so that a render which would produce the same
// thing again can hand back the very objects it handed back before.
//
// Snabbdom's patchVnode returns as soon as it sees the same vnode object on both sides of a diff,
// with the element already carried over, so returning the cached vnodes skips the whole subtree:
// the template closure is not called, no terms are built, no vnodes are allocated and the diff
// stops at the top of the subtree.
//
// An entry is only as good as the question it was keyed on. The key is everything
// Renderer.#renderStatefulComponent reads to produce its output - the module, the merged vars, the
// merged context, the children (slot content) and the parent tag name - plus two things the key
// cannot see on its own:
//
//   - a descendant's own state, which an action can change without touching anything this
//     component passes down (see markDirty and the descendant set each entry carries),
//   - a prop resolved from a query, which reads the local database rather than the key (such a
//     component is never cached, and it un-caches everything it renders inside of).
//
// The cache holds one entry per cid and lives only as long as the page the component registry
// answers for: a new epoch discards everything, since an entry's vnodes point at DOM nodes of a
// page that is gone.
export default class RenderCache {
  // How many term nodes one children comparison may visit before it gives up and reports a
  // difference. A component's children are a template fragment, so the usual comparison is a few
  // nodes or none at all. The budget is what keeps the one case that is not - the layout, whose
  // children are the whole evaluated page - from paying a full tree walk for a comparison that
  // was going to fail anyway.
  static #DOM_COMPARISON_BUDGET = 256;

  // cid key -> entry. An entry is {moduleProxy, vars, context, childrenDom, parentTagName, vdom,
  // bindings, descendantCidKeys}.
  static #entries = new Map();

  // cid keys whose component struct has been rewritten since that component last rendered. A
  // component is dirty for its own entry and for every entry that rendered it.
  static #dirtyCidKeys = new Set();

  // The registry epoch the entries describe, or null when the cache is empty.
  static #epoch = null;

  static #isPassActive = false;

  // cid keys rendered so far in this pass, which is how a cid used twice in one page is caught.
  static #renderedCidKeys = new Set();

  // The components whose render is currently on the stack, outermost first. Each frame collects
  // the cids rendered inside it, so an entry knows which components' state it depends on.
  static #stack = [];

  static get isActive() {
    return $.#isPassActive;
  }

  // Drops the frame of a render that raised. Nothing is stored: the subtree never finished, and
  // the exception is on its way out of the whole render anyway.
  static abandon(frame) {
    if (frame !== null) {
      $.#stack.pop();
    }
  }

  // Opens a render pass. An epoch other than the one the entries were filled at describes a
  // different page, and an entry of a page that has been left holds vnodes pointing at DOM nodes
  // that are no longer in the document.
  static beginPass(epoch) {
    if (epoch !== $.#epoch) {
      $.clear();
      $.#epoch = epoch;
    }

    $.#renderedCidKeys.clear();
    $.#stack.length = 0;
    $.#isPassActive = true;
  }

  static clear() {
    $.#entries.clear();
    $.#dirtyCidKeys.clear();
    $.#epoch = null;
  }

  static endPass() {
    $.#isPassActive = false;
    $.#stack.length = 0;
  }

  // Opens a component's own frame, or answers null when nothing about this render may be stored:
  // outside a pass, for a component that reads a query, and for a cid that has already rendered
  // once in this pass.
  //
  // A repeated cid is the one case that is not just "do not cache": two places in the page would
  // be handed the same vnodes, and the second place would adopt the first place's DOM nodes. The
  // entry is dropped so neither place can be served from it later.
  static enter(cidKey, isCacheable, bindingCounts) {
    if (!$.#isPassActive) {
      return null;
    }

    if ($.#renderedCidKeys.has(cidKey)) {
      $.#entries.delete(cidKey);
      return null;
    }

    $.#renderedCidKeys.add(cidKey);
    $.#dirtyCidKeys.delete(cidKey);

    const frame = {
      bindingCounts: bindingCounts,
      cidKey: cidKey,
      descendantCidKeys: new Set(),
      isCacheable: isCacheable,
    };

    $.#stack.push(frame);

    return frame;
  }

  // The entry that can stand for this render of the component, or null when there is none.
  static hit(cidKey, key) {
    if (!$.#isPassActive || $.#renderedCidKeys.has(cidKey)) {
      return null;
    }

    const entry = $.#entries.get(cidKey);

    if (entry === undefined || $.#isDirty(cidKey, entry)) {
      return null;
    }

    return $.#matches(entry, key) ? entry : null;
  }

  // Closes a component's frame and stores what it rendered. The cids collected in the frame are
  // the components this render walked through, and they travel up to the enclosing frame as well:
  // an entry is invalidated by a state change anywhere beneath it, however deep.
  static leave(frame, entry) {
    $.#stack.pop();

    const parentFrame = $.#stack[$.#stack.length - 1];

    if (parentFrame) {
      parentFrame.descendantCidKeys.add(frame.cidKey);

      for (const cidKey of frame.descendantCidKeys) {
        parentFrame.descendantCidKeys.add(cidKey);
      }
    }

    if (frame.isCacheable) {
      entry.descendantCidKeys = frame.descendantCidKeys;
      $.#entries.set(frame.cidKey, entry);
    } else {
      $.#entries.delete(frame.cidKey);
    }
  }

  // Marks a component as having state that no entry has seen yet. Called where the registry takes
  // a new component struct, which is the only way a component's state or emitted context changes
  // between renders.
  static markDirty(cid) {
    $.#dirtyCidKeys.add(Type.encodeMapKey(cid));
  }

  // Takes every render currently on the stack out of the cache. Called for a component whose
  // output does not follow from its inputs - one with a prop resolved from a query - since an
  // enclosing entry standing in for its own subtree would stand in for that component too.
  static poison() {
    for (const frame of $.#stack) {
      frame.isCacheable = false;
    }
  }

  // Records a served entry as if its subtree had just been rendered: its cid and the cids beneath
  // it belong to the enclosing frame the same way, or an enclosing entry would not know that this
  // subtree's components are part of it.
  static replay(cidKey, entry) {
    $.#renderedCidKeys.add(cidKey);

    const parentFrame = $.#stack[$.#stack.length - 1];

    if (parentFrame) {
      parentFrame.descendantCidKeys.add(cidKey);

      for (const descendantCidKey of entry.descendantCidKeys) {
        parentFrame.descendantCidKeys.add(descendantCidKey);
      }
    }
  }

  // Compares two children (slot content) DOM terms, returning what is left of the budget or -1
  // for "different, or too big to tell". Identical subterms cost nothing, which is what makes
  // this affordable: a template rebuilds its own nodes on every render, but the values it carries
  // into them come from vars and are the same objects while they are untouched.
  static #compareDom(left, right, budget) {
    if (left === right) {
      return budget;
    }

    if (budget <= 0) {
      return -1;
    }

    if (
      left === null ||
      right === null ||
      typeof left !== "object" ||
      typeof right !== "object" ||
      left.type !== right.type
    ) {
      return -1;
    }

    switch (left.type) {
      case "list":
      case "tuple": {
        const leftItems = left.data;
        const rightItems = right.data;

        if (leftItems.length !== rightItems.length) {
          return -1;
        }

        let remaining = budget - 1;

        for (let index = 0; index < leftItems.length; index += 1) {
          remaining = $.#compareDom(
            leftItems[index],
            rightItems[index],
            remaining,
          );

          if (remaining === -1) {
            return -1;
          }
        }

        return remaining;
      }

      default:
        // Everything else is a value a template carried into the node, and values are compared the
        // way vars are: by identity, or by what they say when they are scalar.
        return $.#isSameValue(left, right) ? budget - 1 : -1;
    }
  }

  static #isDirty(cidKey, entry) {
    if ($.#dirtyCidKeys.has(cidKey)) {
      return true;
    }

    for (const descendantCidKey of entry.descendantCidKeys) {
      if ($.#dirtyCidKeys.has(descendantCidKey)) {
        return true;
      }
    }

    return false;
  }

  // Whether two maps hold the same entries, compared one value at a time rather than deeply. A map
  // is rebuilt on every render - vars is a fresh merge of props and state - so the map object
  // itself never compares equal, while the values in it do: an untouched term is the same object
  // it was last render.
  static #isSameMap(left, right) {
    if (left === right) {
      return true;
    }

    const leftData = left.data;
    const rightData = right.data;
    const leftKeys = Object.keys(leftData);

    if (leftKeys.length !== Object.keys(rightData).length) {
      return false;
    }

    for (const key of leftKeys) {
      const rightEntry = rightData[key];

      if (
        rightEntry === undefined ||
        !$.#isSameValue(leftData[key][1], rightEntry[1])
      ) {
        return false;
      }
    }

    return true;
  }

  // Whether two boxed terms are the same value, cheaply.
  //
  // Identity answers it for anything that came through untouched, which is the common case and
  // the only case for a map, a list or a tuple: walking one of those would give back the work the
  // cache is there to save, so a rebuilt collection simply counts as a difference.
  //
  // A scalar is compared by what it says, because a template rebuilds the scalars it writes on
  // every render - a cid, a class name, a number - and comparing those by identity alone would
  // leave almost nothing cacheable. A bitstring is compared only when both sides carry their text,
  // which is how a bitstring that came from a string literal is stored.
  static #isSameValue(left, right) {
    if (left === right) {
      return true;
    }

    if (
      left === null ||
      right === null ||
      typeof left !== "object" ||
      typeof right !== "object" ||
      left.type !== right.type
    ) {
      return false;
    }

    switch (left.type) {
      case "atom":
      case "integer":
      case "float":
        return left.value === right.value;

      case "bitstring":
        // Only the text form answers this. `text` is null until something decodes the bytes and
        // false when they are not valid UTF-8, so the type check is what keeps two different
        // undecodable bitstrings from both reading as false and comparing equal. The bit count
        // goes with it: a text bitstring carries no leftover bits, and one that does is never
        // equal to one that does not.
        return (
          typeof left.text === "string" &&
          typeof right.text === "string" &&
          left.leftoverBitCount === right.leftoverBitCount &&
          left.text === right.text
        );

      default:
        return false;
    }
  }

  static #matches(entry, key) {
    return (
      entry.moduleProxy === key.moduleProxy &&
      entry.parentTagName === key.parentTagName &&
      $.#isSameMap(entry.vars, key.vars) &&
      $.#isSameMap(entry.context, key.context) &&
      $.#compareDom(
        entry.childrenDom,
        key.childrenDom,
        $.#DOM_COMPARISON_BUDGET,
      ) !== -1
    );
  }
}

const $ = RenderCache;
