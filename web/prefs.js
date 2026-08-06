"use strict";
/*
 * UI preferences — the single seam for anything the UI wants remembered.
 *
 * Disk over localStorage: localStorage is keyed to the origin including the
 * port, and every run binds a new random port, so anything written there is
 * invisible to the next session. The server holds a flat JSON object on disk
 * (per user, not per repo — a pane width is a fact about your screen) and
 * never interprets the keys.
 *
 * Writes are debounced key-level patches, not snapshots: the server merges
 * per key, so a concurrent session's settings are never clobbered by ours.
 */
window.Prefs = {
  data: {},
  pending: {}, // only what THIS session changed
  timer: null,

  async load() {
    let disk = {};
    try {
      disk = (await (await fetch("/api/prefs")).json()) || {};
    } catch {
      /* defaults are always an acceptable answer */
    }
    /* Merge under, never replace: the ☰ button and the splitters are live
       while this request is in flight, and a click in that window has already
       written into `data`. Replacing would invert memory against disk — the
       click's value POSTs, but memory holds the disk value, so the reader's
       next toggle no-ops on the equality guard and the wrong state sticks. */
    this.data = { ...disk, ...this.data };
  },

  get(key, dflt) {
    return key in this.data ? this.data[key] : dflt;
  },

  set(key, value) {
    if (this.data[key] === value) return;
    this.data[key] = value;
    this.pending[key] = value;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const patch = this.pending;
      this.pending = {};
      fetch("/api/prefs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      }).catch(() => {}); // lost prefs must never take the review down
    }, 250);
  },
};
