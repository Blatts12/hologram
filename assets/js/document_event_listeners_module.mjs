// Custom Snabbdom module for document-level event listeners.
// Based on: https://github.com/snabbdom/snabbdom/blob/master/src/modules/eventlisteners.ts
//
// Usage: set `ondocument` on vnode data, e.g.:
//   vnode("div", {ondocument: {click: handler, keydown: handler}}, children)
//
// Listeners are added to `document` (not the element) and automatically
// cleaned up on destroy/update.

"use strict";

function invokeHandler(handler, vnode, event) {
  if (typeof handler === "function") {
    handler.call(vnode, event, vnode);
  } else if (typeof handler === "object") {
    for (let i = 0; i < handler.length; i++) {
      invokeHandler(handler[i], vnode, event);
    }
  }
}

function handleEvent(event, vnode) {
  const name = event.type;
  const ondocument = vnode.data.ondocument;

  if (ondocument && ondocument[name]) {
    invokeHandler(ondocument[name], vnode, event);
  }
}

function createListener() {
  return function handler(event) {
    handleEvent(event, handler.vnode);
  };
}

function updateDocumentEventListeners(oldVnode, vnode) {
  const oldOn = oldVnode.data?.ondocument;
  const oldListener = oldVnode.documentListener;
  const newOn = vnode && vnode.data?.ondocument;
  const on = parseEvents(newOn, vnode);

  if (oldOn === on) {
    return;
  }

  if (oldOn && oldListener) {
    if (!on) {
      for (const name in oldOn) {
        document.removeEventListener(name, oldListener, false);
      }
    } else {
      for (const name in oldOn) {
        if (!on[name]) {
          document.removeEventListener(name, oldListener, false);
        }
      }
    }
  }

  if (on) {
    const listener = (vnode.documentListener =
      oldVnode.documentListener || createListener());
    listener.vnode = vnode;

    if (!oldOn) {
      for (const name in on) {
        document.addEventListener(name, listener, false);
      }
    } else {
      for (const name in on) {
        if (!oldOn[name]) {
          document.addEventListener(name, listener, false);
        }
      }
    }
  }
}

function parseEvents(events, vnode) {
  if (events.clickaway) {
    const handler = (event) => {
      if (!vnode.el.contains(event.target)) {
        events.clickaway(event, vnode);
      }
    };

    events.click = handler;
    delete events.clickaway;
    return events;
  } else {
    return events;
  }
}

export const documentEventListenersModule = {
  create: updateDocumentEventListeners,
  update: updateDocumentEventListeners,
  destroy: updateDocumentEventListeners,
};
