/* The home page's React islands. The page is plain HTML that reads fine with
 * no JavaScript; this file swaps a few spots for React Bits components: the dot
 * field behind the hero, the headline's entrance, the typed prompt, the magnet
 * buttons and the spotlight on the three promises. scripts/build-site.sh
 * bundles it into site/home.bundle.js, which only index.html loads. Kept out
 * of site/ so the website serves the bundle, not the React Bits sources.
 */
import { createRoot } from "react-dom/client";
import DotGrid from "./reactbits/DotGrid.jsx";
import SplitText from "./reactbits/SplitText.jsx";
import TextType from "./reactbits/TextType.jsx";
import Magnet from "./reactbits/Magnet.jsx";
import SpotlightCard from "./reactbits/SpotlightCard.jsx";

const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
const mount = (sel, node) => {
  const el = document.querySelector(sel);
  if (el) createRoot(el).render(node);
};

// Behind the hero: dots that lean toward the pointer, like the map's canvas.
if (!still) {
  mount(
    "#heroDots",
    <DotGrid dotSize={3} gap={26} baseColor="#232a36" activeColor="#5be08a" proximity={130} shockRadius={220} shockStrength={3} glow={0.35} fade={0.55} />
  );
}

// The headline rises in, one line after the other.
if (!still) {
  mount(
    "#heroTitle",
    <h1>
      <SplitText tag="span" text="Big code reviews," splitType="chars" delay={28} duration={0.9} trigger="load" textAlign="center" />
      <br />
      <SplitText tag="span" text="made small." splitType="chars" delay={28} duration={0.9} trigger="load" textAlign="center" accentColor="#5be08a" />
    </h1>
  );
}

// The one sentence you type to your agent.
const asks = [
  "use diffotator to review github.com/you/shop/pull/42",
  "use diffotator to review gitlab.com/you/shop/-/merge_requests/42",
  "use diffotator to review my changes",
];
if (!still) {
  mount(
    "#askText",
    <TextType as="span" text={asks} typingSpeed={42} deletingSpeed={18} pauseDuration={2600} initialDelay={700} cursorCharacter="▋" cursorColor="#5be08a" variableSpeed={{ min: 28, max: 70 }} />
  );
}

// Buttons that lean toward the pointer.
const cta = document.querySelector("#heroCta");
if (cta && !still) {
  const links = [...cta.querySelectorAll("a")].map((a) => ({ href: a.getAttribute("href"), cls: a.className, text: a.textContent }));
  createRoot(cta).render(
    <>
      {links.map((l) => (
        <Magnet key={l.href} padding={60} magnetStrength={4}>
          <a className={l.cls} href={l.href}>{l.text}</a>
        </Magnet>
      ))}
    </>
  );
}

// A soft light that follows the pointer across the three promises.
document.querySelectorAll(".promise").forEach((el) => {
  const html = el.innerHTML; // our own static markup, written in index.html
  createRoot(el).render(
    <SpotlightCard className="promise-card" spotlightColor="rgba(91, 224, 138, 0.18)" intensity={0.18} grain={0} theme="dark">
      <div className="promise-body" dangerouslySetInnerHTML={{ __html: html }} />
    </SpotlightCard>
  );
});
