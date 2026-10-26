"use strict";
/**
 * The conversation between the reviewer and their agent during one review:
 * questions asked from the page, the agent's answers, and the queue of things
 * the agent has yet to hear about (a question, or the finished review). The
 * server (src/server.js) owns one of these per review; the CLI turns what it
 * hands out into text with `formatEvent`. No sockets here, so `node test.js`
 * can drive a whole conversation.
 */

function createTalk() {
  const items = []; // { id, text, context, askedAt, answer, answeredAt }
  const queue = []; // { type: "question", id } | { type: "done", decision, output }
  const waiting = []; // resolvers of agents currently waiting for the next event
  let nextId = 1;
  let finished = false;

  /* The finished review is for everyone: every waiter gets it, and it stays
     queued for anyone who comes later. A question goes to one waiter. */
  const deliver = () => {
    while (queue.length && waiting.length) {
      if (queue[0].type === "done") waiting.splice(0).forEach((w) => w(queue[0]));
      else waiting.shift()(queue.shift());
    }
  };

  return {
    /** A question from the page. `context` is { file, side, line, text } or null. */
    ask(text, context = null) {
      const item = { id: nextId++, text, context, askedAt: Date.now(), answer: null, answeredAt: null };
      items.push(item);
      queue.push({ type: "question", id: item.id });
      deliver();
      return item;
    },

    /** The agent's answer, to question `id` or else the oldest one still open. */
    answer(id, text) {
      const item = id ? items.find((x) => x.id === id) : items.find((x) => x.answer === null);
      if (!item) return null;
      item.answer = text;
      item.answeredAt = Date.now();
      return item;
    },

    /** The review is over: the agent's next wait gets the result. */
    finish(decision, output) {
      finished = true;
      queue.push({ type: "done", decision, output });
      deliver();
    },

    /**
     * Resolve with the next event for the agent, or `{ type: "none" }` after
     * `timeoutMs` (or once `signal` aborts) so long-polls can be renewed. A
     * question is handed out with its full text, read at delivery time.
     */
    next(timeoutMs = 25000, signal = null) {
      return new Promise((resolve) => {
        const done = (ev) => {
          clearTimeout(timer);
          resolve(ev.type === "question" ? { ...ev, ...items.find((x) => x.id === ev.id) } : ev);
        };
        const quit = () => {
          const i = waiting.indexOf(done);
          if (i >= 0) waiting.splice(i, 1), resolve({ type: "none" });
        };
        const timer = setTimeout(quit, timeoutMs);
        if (signal) signal.addEventListener("abort", quit);
        waiting.push(done);
        deliver();
      });
    },

    /** A question handed to an agent that hung up before reading it goes back to the front. */
    putBack(ev) {
      if (ev.type !== "question") return; // the finished review never left the queue
      queue.unshift({ type: "question", id: ev.id });
      deliver();
    },

    /** True once the review was sent: it can still be collected, but not reused. */
    finished: () => finished,

    /** What the page shows: every question with its answer, and whether an agent is listening. */
    thread() {
      return { items: items.map((x) => ({ ...x })), listening: waiting.length > 0 };
    },
  };
}

/** What the agent reads on stdout for one event. */
function formatEvent(ev) {
  if (ev.type === "done") return ev.output || "Review session closed without feedback.";
  if (ev.type !== "question") return "";
  const where = ev.context && ev.context.file
    ? `About \`${ev.context.file}\`${ev.context.line ? `:${ev.context.line}` : ""}` +
      (ev.context.text ? `\n\n\`\`\`\n${ev.context.text}\n\`\`\`` : "")
    : "";
  return [
    "# Question from the reviewer",
    "",
    "The review is still open in their browser. They asked:",
    "",
    ...ev.text.split("\n").map((l) => `> ${l}`),
    ...(where ? ["", where] : []),
    "",
    `Answer in plain words (markdown is fine) with: diffotator answer --id ${ev.id} "<your answer>"`,
    "That command shows them your answer and then waits for their next message or their finished review.",
  ].join("\n");
}

module.exports = { createTalk, formatEvent };
