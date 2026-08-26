"use strict";
/**
 * Keyboard policy: which keystrokes the app owns, and what Escape releases.
 *
 * Both answers used to be spelled out inline in a keydown handler that needs a
 * document to run, so neither could be asserted — and both were wrong. `c`
 * opened the comment box and then landed in it as the letter "c", because only
 * `case "/"` remembered to preventDefault. Escape released the popover, the
 * search bar, the modal and the help sheet, but not the file filter, so `/` was
 * a documented way in with no way out.
 *
 * No DOM here: app.js says what is open and applies the answer.
 *
 * Loadable from both tiers — Node gets `require`, the browser gets
 * `window.Keys` — so `node test.js` exercises the same code the page runs.
 */
(function (exp) {
  /* The single-key shortcuts the handler owns. All of them get defaulted, not
     just the two that move focus into a text box, because "remember to
     preventDefault in this case" is the rule that already got forgotten once. */
  const SHORTCUTS = "jknpsfvt?/cb[]w";

  /**
   * The shortcut a keystroke means, or null for one the page keeps.
   * A modifier means it is not ours: ⌘C copies, it does not open a comment.
   */
  function shortcut(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return null;
    return e.key && e.key.length === 1 && SHORTCUTS.includes(e.key) ? e.key : null;
  }

  /* Everything Escape can release, topmost first. The filter is last because it
     is not an overlay — it only holds focus — so anything drawn over it goes
     first. Adding a way in without adding an entry here is the bug this list
     exists to make obvious. */
  const DISMISS_ORDER = ["popover", "searchBar", "modal", "helpSheet", "fileFilter"];

  /** Which one to release, given what is open, or null if nothing is. */
  function dismissTarget(open) {
    return DISMISS_ORDER.find((id) => open[id]) || null;
  }

  exp.SHORTCUTS = SHORTCUTS;
  exp.shortcut = shortcut;
  exp.DISMISS_ORDER = DISMISS_ORDER;
  exp.dismissTarget = dismissTarget;
})(typeof module === "object" && module.exports ? module.exports : (window.Keys = {}));
