"use strict";
/**
 * The few things that differ between operating systems and between agents:
 * how to open a browser, and where an agent looks for diffotator's
 * instructions. The CLI (bin/diffotator.js) calls both — `browserCommand` on
 * every review, `setupAgent` from `diffotator setup`. Kept out of the CLI file
 * so `node test.js` can check them for every platform from any machine.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

/**
 * The program and arguments that open `url` in the default browser.
 * On Windows `start` is built into cmd.exe rather than being a program, and
 * its first quoted argument is a window title — hence the empty "".
 */
function browserCommand(platform, url) {
  if (platform === "darwin") return ["open", [url]];
  if (platform === "win32") return ["cmd", ["/c", "start", "", url]];
  return ["xdg-open", [url]];
}

/** The instructions an agent follows to open reviews: the /diffotator command. */
const COMMAND_FILE = path.join(__dirname, "..", "claude", "diffotator.md");

/**
 * Install the /diffotator command for Claude Code when Claude Code is there
 * (it keeps its files in ~/.claude), overwriting an older copy so re-running
 * after an upgrade is how you update it. Other agents get the file's path to
 * add to their own instructions. Returns what happened, for the CLI to print.
 */
function setupAgent({ home = os.homedir(), source = COMMAND_FILE } = {}) {
  const claude = path.join(home, ".claude");
  if (!fs.existsSync(claude)) return { installed: null, source };
  const dest = path.join(claude, "commands", "diffotator.md");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(source, dest);
  return { installed: dest, source };
}

module.exports = { browserCommand, setupAgent, COMMAND_FILE };
