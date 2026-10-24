// Where the prototype on screen is in its own pages, from what its bridge reports. A frame's
// history.back() walks the desk's joint session history: on the prototype's first page it would
// take the desk itself back. So "go back" only goes to the page the prototype came from.

export function createProtoNav() {
  let id = null;
  let stack = [];
  let index = -1;
  let pendingBack = false;
  const reset = (prototypeId) => {
    id = prototypeId;
    stack = [];
    index = -1;
    pendingBack = false;
  };
  return {
    reset,
    /** The page reported a path (on load, or after a change). */
    page(prototypeId, path) {
      if (prototypeId !== id) reset(prototypeId);
      if (pendingBack && index > 0 && stack[index - 1] === path) {
        index -= 1;
        pendingBack = false;
        return;
      }
      pendingBack = false;
      if (stack[index] === path) return;
      stack = stack.slice(0, index + 1);
      stack.push(path);
      index = stack.length - 1;
    },
    canGoBack(prototypeId) {
      return prototypeId === id && index > 0;
    },
    goingBack() {
      pendingBack = true;
    },
  };
}
