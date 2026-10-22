/* The home page's plain-JS behaviour: scrolling through "How it works" plays
 * the scene beside it, and the copy buttons copy. The React Bits pieces live
 * in site-src/home.jsx. Only index.html loads this file.
 */
(function () {
  // --- how it works: the step in the middle of the screen plays on the stage ---
  const stage = document.querySelector(".stage");
  const steps = [...document.querySelectorAll(".steps li")];
  if (stage && steps.length) {
    const show = (li) => {
      steps.forEach((s) => s.classList.toggle("on", s === li));
      if (stage.dataset.step === li.dataset.step) return;
      // Re-trigger the sorting animation each time step 2 comes back.
      stage.dataset.step = "";
      void stage.offsetWidth;
      stage.dataset.step = li.dataset.step;
    };
    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => e.isIntersecting && show(e.target)),
      { rootMargin: "-45% 0px -45% 0px" }
    );
    steps.forEach((s) => io.observe(s));
    show(steps[0]);
  }

  // --- copy buttons ------------------------------------------------------------
  document.addEventListener("click", async (e) => {
    const btn = e.target.closest(".copy");
    if (!btn) return;
    const from = btn.dataset.copyFrom && document.getElementById(btn.dataset.copyFrom);
    const value = from ? from.textContent.replace(/^#.*$\n?/gm, "").replace(/\n{2,}/g, "\n").trim() + "\n" : btn.dataset.copy;
    try {
      await navigator.clipboard.writeText(value);
      btn.textContent = "Copied";
      btn.classList.add("done");
    } catch {
      btn.textContent = "Press ⌘C";
    }
    setTimeout(() => {
      btn.textContent = "Copy";
      btn.classList.remove("done");
    }, 1600);
  });
})();
