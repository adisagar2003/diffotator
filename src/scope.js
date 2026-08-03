"use strict";
/**
 * A scope is what we are diffing. Everything downstream — the changed-file
 * list, one file's diff, whole-file content, the repo tree, the feedback
 * header — is expressed in terms of one:
 *
 *   worktree                working tree + index vs HEAD (+ untracked)
 *   commit:<sha>            a single commit vs its first parent
 *   range:<base>...<head>   e.g. branch vs origin/main
 *
 * `type` used to be a type code that eight callers each decoded with their own
 * ternary — three in the git layer, two in the browser, and two labellers that
 * had already drifted ("working tree vs HEAD" vs "local changes (working tree
 * vs HEAD)"). Every question you can ask about a scope is now answered by one
 * entry in KINDS, so a fourth kind is one object here and no edits anywhere
 * else.
 *
 * Scopes stay plain JSON — they travel in a query string and in the submit
 * payload — so the behaviour lives in this table rather than on the objects.
 *
 * Loadable from both tiers: Node gets `require("./scope")`, the browser gets
 * `window.Scope`, so the wire format has exactly one definition.
 */
(function (exp) {
  const short = (sha) => String(sha || "").slice(0, 8);

  /**
   * Refs arrive in a query string and leave as git arguments. A ref starting
   * with `-` would be read by git as an option, so refuse it once here rather
   * than trusting eight call sites to remember.
   */
  const REF = /^[^-\s\x00-\x1f][^\s\x00-\x1f]*$/;
  function ref(v, what) {
    const s = v == null ? "" : String(v);
    if (!REF.test(s)) throw new Error(`invalid ${what}: ${JSON.stringify(s)}`);
    return s;
  }

  /**
   * One entry per kind. `git` is the tiny port the git layer injects for the
   * two facts only it can supply, which keeps this file loadable in a browser.
   */
  const KINDS = {
    worktree: {
      encode: () => "worktree",
      decode: () => ({ type: "worktree" }),
      label: () => "working tree vs HEAD",
      rev: () => "HEAD",
      // A repo with no commits has no HEAD to diff against. The empty tree is
      // what "everything here is new" means to git, and a freshly scaffolded
      // repo is exactly the case an agent leaves behind.
      diffArgs: async (s, git) => [(await git.headExists()) ? "HEAD" : await git.emptyTree()],
    },

    commit: {
      encode: (s) => "commit:" + ref(s.sha, "sha"),
      decode: (rest) => ({ type: "commit", sha: ref(rest, "sha") }),
      label: (s) => `commit ${short(s.sha)}`,
      rev: (s) => ref(s.sha, "sha"),
      /**
       * Both endpoints are named rather than using the tempting `sha^!`: `^!`
       * excludes *every* parent, so a merge diffs to nothing at all, and a root
       * commit has no `^` to exclude and silently diffs the wrong way round.
       * First parent only — for a merge that means "what this merge brought
       * in", which is what a reviewer is looking at.
       */
      diffArgs: async (s, git) => {
        const sha = ref(s.sha, "sha");
        const parents = await git.parents(sha);
        return [parents[0] || (await git.emptyTree()), sha];
      },
    },

    range: {
      encode: (s) => `range:${ref(s.base, "base")}...${ref(s.head || "HEAD", "head")}`,
      decode: (rest) => {
        const at = rest.indexOf("...");
        if (at < 0) throw new Error(`invalid range: ${JSON.stringify(rest)}`);
        return {
          type: "range",
          base: ref(rest.slice(0, at), "base"),
          head: ref(rest.slice(at + 3) || "HEAD", "head"),
        };
      },
      label: (s) => `${ref(s.base, "base")}...${ref(s.head || "HEAD", "head")}`,
      rev: (s) => ref(s.head || "HEAD", "head"),
      diffArgs: async (s) => [`${ref(s.base, "base")}...${ref(s.head || "HEAD", "head")}`],
    },
  };

  const kindOf = (scope) => KINDS[(scope && scope.type) || "worktree"] || KINDS.worktree;

  /** Canonical string form. Doubles as the cache/viewed-state key. */
  const encode = (scope) => kindOf(scope).encode(scope || {});

  /** Inverse of `encode`. Throws on a malformed ref rather than reviewing the wrong thing. */
  function parse(str) {
    const s = str == null || str === "" ? "worktree" : String(str);
    const at = s.indexOf(":");
    const type = at < 0 ? s : s.slice(0, at);
    const kind = KINDS[type];
    if (!kind) throw new Error(`unknown scope: ${JSON.stringify(s)}`);
    return kind.decode(at < 0 ? "" : s.slice(at + 1));
  }

  exp.parse = parse;
  exp.encode = encode;
  /** Human text, one register for both the header chip and the feedback markdown. */
  exp.label = (scope) => kindOf(scope).label(scope || {});
  /** The revision whose "after" side this scope shows — for `git show` / `ls-tree`. */
  exp.rev = (scope) => kindOf(scope).rev(scope || {});
  /** Arguments naming the two sides of the diff. `git` is `{headExists, emptyTree, parents}`. */
  exp.diffArgs = (scope, git) => kindOf(scope).diffArgs(scope || {}, git);
  /** Only the worktree scope has untracked files and an index. */
  exp.isWorktree = (scope) => kindOf(scope) === KINDS.worktree;
  /** Every kind, so a test can prove a newly added one round-trips. */
  exp.TYPES = Object.keys(KINDS);
})(typeof module === "object" && module.exports ? module.exports : (window.Scope = {}));
