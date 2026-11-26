/**
 * Everything the widget looks like. It is applied inside a shadow root, so the
 * host page's CSS cannot reach in and none of this can leak out.
 *
 * A site restyles it through the custom properties at the top; the element sets
 * them from its attributes.
 */
export const STYLES = /* css */ `
:host {
  --nd-accent: #b7ff1a;
  --nd-on-accent: #050505;
  --nd-edge: linear-gradient(135deg, #b7ff1a, #00e5ff);
  --nd-link: #00e5ff;
  --nd-bg: #0a0c0d;
  --nd-surface: #14181b;
  --nd-text: #f5f7fa;
  --nd-muted: #b3bbc3;
  --nd-faint: #8a939c;
  --nd-line: rgb(245 247 250 / 0.14);
  --nd-shadow: 0 18px 44px rgb(0 0 0 / 0.5);
  --nd-font: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  --nd-display: Sora, var(--nd-font);
  --nd-cut: 16px;
  --nd-radius: 0px;
  all: initial;
}
:host([theme="light"]) {
  --nd-edge: rgb(16 24 28 / 0.18);
  --nd-link: #10181c;
  --nd-bg: #ffffff;
  --nd-surface: #f0f3f5;
  --nd-text: #10181c;
  --nd-muted: #48565e;
  --nd-faint: #5f6c74;
  --nd-line: rgb(16 24 28 / 0.16);
  --nd-shadow: 0 18px 44px rgb(16 24 28 / 0.22);
}
:host([corners="round"]) { --nd-cut: 0px; --nd-radius: 18px; }
:host([corners="square"]) { --nd-cut: 0px; --nd-radius: 0px; }

*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }

.nd {
  position: fixed;
  right: 20px;
  bottom: 20px;
  z-index: 2147483000;
  font: 400 15px/1.5 var(--nd-font);
  color: var(--nd-text);
  -webkit-font-smoothing: antialiased;
}
.nd[data-position="bottom-left"] { right: auto; left: 20px; }

button, textarea { font: inherit; color: inherit; }
button { cursor: pointer; }
:focus-visible { outline: 2px solid var(--nd-link); outline-offset: 2px; }

/* A shape with the brand's cut corners, or rounded ones, from the same two numbers. */
.nd-cut {
  border-radius: var(--nd-radius);
  clip-path: polygon(
    var(--nd-cut) 0, 100% 0, 100% calc(100% - var(--nd-cut)),
    calc(100% - var(--nd-cut)) 100%, 0 100%, 0 var(--nd-cut)
  );
}

/* ---------- launcher ---------- */
.nd-launcher {
  display: block;
  width: 72px;
  height: 72px;
  margin-left: auto;
  padding: 1.5px;
  border: 0;
  background: var(--nd-edge);
  filter: drop-shadow(0 6px 16px rgb(0 0 0 / 0.35));
  transition: transform 0.18s cubic-bezier(0.34, 1.4, 0.64, 1);
}
.nd[data-position="bottom-left"] .nd-launcher { margin-left: 0; }
.nd-launcher:hover { transform: scale(1.06); }
.nd-launcher:active { transform: scale(0.96); }
.nd-launcher-face {
  display: grid;
  place-items: center;
  width: 100%;
  height: 100%;
  background: var(--nd-bg);
  color: var(--nd-muted);
}
.nd-slot { width: 58px; aspect-ratio: 560 / 480; }
.nd-launcher svg { display: none; }
.nd[data-open] .nd-launcher svg { display: block; }
.nd[data-open] .nd-launcher .nd-slot { display: none; }

.nd-nudge {
  position: absolute;
  right: 86px;
  bottom: 14px;
  width: max-content;
  max-width: 240px;
  padding: 10px 14px;
  background: var(--nd-surface);
  border: 1px solid var(--nd-line);
  border-radius: var(--nd-radius);
  font-size: 14px;
  animation: nd-rise 0.3s cubic-bezier(0.16, 1, 0.3, 1) both;
}
.nd[data-position="bottom-left"] .nd-nudge { right: auto; left: 86px; }

/* ---------- panel ---------- */
.nd-panel {
  position: absolute;
  right: 0;
  bottom: 92px;
  width: min(392px, calc(100vw - 24px));
  height: min(640px, calc(100vh - 164px));
  height: min(640px, calc(100dvh - 164px));
  filter: drop-shadow(var(--nd-shadow));
  transform-origin: 100% 100%;
  animation: nd-open 0.26s cubic-bezier(0.16, 1, 0.3, 1) both;
}
.nd[data-position="bottom-left"] .nd-panel { right: auto; left: 0; transform-origin: 0 100%; }
.nd-panel[data-closing] { animation: nd-close 0.18s ease-in both; }
.nd-edge { height: 100%; padding: 1.5px; background: var(--nd-edge); }
.nd-surface { display: flex; flex-direction: column; height: 100%; background: var(--nd-bg); }
:host([corners="round"]) .nd-surface { border-radius: calc(var(--nd-radius) - 1.5px); }

.nd-header {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 72px;
  padding: 12px 8px 12px 18px;
  border-bottom: 1px solid var(--nd-line);
}
/* Room for the mascot, which sits half above the panel's top edge. */
.nd[data-mascot] .nd-header { padding-left: 142px; }
.nd-perch {
  position: absolute;
  left: 18px;
  top: -44px;
  width: 112px;
  aspect-ratio: 560 / 480;
  pointer-events: none;
}
.nd-title { flex: 1; min-width: 0; }
.nd-name {
  margin: 0;
  font: 800 17px/1.25 var(--nd-display);
  letter-spacing: -0.01em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nd-status { margin: 2px 0 0; font-size: 12.5px; line-height: 1.35; color: var(--nd-muted); }
.nd-icon-button {
  display: grid;
  place-items: center;
  flex: none;
  width: 44px;
  height: 44px;
  padding: 0;
  border: 0;
  background: none;
  color: var(--nd-muted);
}
.nd-icon-button:hover { color: var(--nd-text); }

.nd-log {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 18px 16px 12px;
  scrollbar-width: thin;
  scrollbar-color: var(--nd-line) transparent;
}
.nd-message { max-width: 88%; animation: nd-rise 0.28s cubic-bezier(0.16, 1, 0.3, 1) both; }
.nd-message[data-role="assistant"] { align-self: flex-start; }
.nd-message[data-role="customer"] { align-self: flex-end; }
.nd-bubble {
  --nd-cut: 10px;
  padding: 10px 14px;
  background: var(--nd-surface);
  font-size: 14.5px;
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  clip-path: polygon(0 0, 100% 0, 100% 100%, var(--nd-cut) 100%, 0 calc(100% - var(--nd-cut)));
}
:host(:not([corners])) .nd-bubble, :host([corners="cut"]) .nd-bubble { border-radius: 0; }
:host([corners="round"]) .nd-bubble { border-radius: 14px; clip-path: none; }
:host([corners="square"]) .nd-bubble { clip-path: none; }
.nd-message[data-role="customer"] .nd-bubble {
  background: var(--nd-accent);
  color: var(--nd-on-accent);
  font-weight: 500;
  clip-path: polygon(0 0, 100% 0, 100% calc(100% - var(--nd-cut)), calc(100% - var(--nd-cut)) 100%, 0 100%);
}
:host([corners="round"]) .nd-message[data-role="customer"] .nd-bubble,
:host([corners="square"]) .nd-message[data-role="customer"] .nd-bubble { clip-path: none; }
.nd-bubble[data-failed] { color: var(--nd-muted); }

.nd-marker {
  display: inline-block;
  min-width: 1.5em;
  margin: 0 1px;
  padding: 0 4px;
  border: 1px solid var(--nd-line);
  font: 600 11px/1.5 var(--nd-display);
  text-align: center;
  text-decoration: none;
  vertical-align: 1px;
  color: var(--nd-link);
}
.nd-reading::after { content: "…"; animation: nd-blink 1.2s steps(4, end) infinite; }

.nd-label {
  margin: 0 0 6px;
  font-size: 11.5px;
  font-weight: 500;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--nd-faint);
}
.nd-sources { margin: 10px 0 0; }
.nd-sources ol { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
.nd-source {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 44px;
  padding: 6px 12px;
  border: 1px solid var(--nd-line);
  border-radius: var(--nd-radius);
  font-size: 13px;
  line-height: 1.35;
  color: var(--nd-muted);
  text-decoration: none;
}
a.nd-source:hover { border-color: var(--nd-accent); color: var(--nd-text); }
.nd-source b { font: 600 13px var(--nd-display); color: var(--nd-link); }

.nd-handoff {
  display: grid;
  gap: 8px;
  margin: 10px 0 0;
  padding: 14px;
  border: 1px solid var(--nd-accent);
  border-radius: var(--nd-radius);
}
.nd-handoff strong { font: 600 14.5px/1.3 var(--nd-display); }
.nd-handoff p { margin: 0; font-size: 13.5px; color: var(--nd-muted); }
.nd-button {
  justify-self: start;
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  padding: 0 16px;
  border: 0;
  border-radius: var(--nd-radius);
  background: var(--nd-accent);
  color: var(--nd-on-accent);
  font-size: 14px;
  font-weight: 600;
  text-decoration: none;
}
.nd-text-button {
  min-height: 44px;
  margin-top: 4px;
  padding: 0;
  border: 0;
  background: none;
  color: var(--nd-link);
  font-size: 13.5px;
  text-decoration: underline;
  text-underline-offset: 3px;
}

.nd-suggestions { display: grid; justify-items: start; gap: 8px; margin-top: 4px; }
.nd-chip {
  min-height: 44px;
  padding: 8px 14px;
  border: 1px solid var(--nd-line);
  border-radius: var(--nd-radius);
  background: none;
  font-size: 14px;
  line-height: 1.35;
  text-align: left;
  transition: border-color 0.15s, transform 0.15s;
}
.nd-chip:hover { border-color: var(--nd-accent); transform: translateX(2px); }

.nd-composer {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 10px 14px 8px;
  border-top: 1px solid var(--nd-line);
}
.nd-input {
  flex: 1;
  min-width: 0;
  min-height: 46px;
  max-height: 132px;
  padding: 11px 12px;
  border: 1px solid var(--nd-line);
  border-radius: var(--nd-radius);
  background: var(--nd-surface);
  font-size: 15px;
  line-height: 1.5;
  resize: none;
}
.nd-input::placeholder { color: var(--nd-faint); opacity: 1; }
.nd-send {
  --nd-cut: 10px;
  display: grid;
  place-items: center;
  flex: none;
  width: 46px;
  height: 46px;
  padding: 0;
  border: 0;
  background: var(--nd-accent);
  color: var(--nd-on-accent);
  transition: transform 0.15s cubic-bezier(0.34, 1.4, 0.64, 1), opacity 0.15s;
}
.nd-send:not(:disabled):hover { transform: translateY(-2px); }
.nd-send:disabled { opacity: 0.45; cursor: default; }
.nd-footer { margin: 0; padding: 0 16px 12px; font-size: 11.5px; color: var(--nd-faint); }
.nd-footer a { color: inherit; }

/* ---------- mascot ---------- */
.nd-mascot {
  position: fixed;
  left: 0;
  top: 0;
  width: 112px;
  transform-origin: 0 0;
  pointer-events: none;
  z-index: 1;
  will-change: transform;
}
.nd[data-open] .nd-mascot { pointer-events: auto; cursor: pointer; }
.nd-mascot img { display: block; width: 100%; aspect-ratio: 560 / 480; object-fit: contain; }
.nd-mascot[data-mood="thinking"] img { animation: nd-pulse 0.9s ease-in-out infinite; }

/* Every character is moved by the same few numbers, which the rig sets each frame. */
.ndc { --ndc-look-x: 0; --ndc-look-y: 0; --ndc-lid: 0; --ndc-jaw: 0; --ndc-signal: 0; }
.ndc-body { transform-origin: 50% 100%; }
.ndc-svg {
  /* The brightness of the signal light. A character with no mouth also flickers it to speak. */
  --ndc-light: var(--ndc-signal);
  display: block;
  width: 100%;
  aspect-ratio: 560 / 480;
  overflow: visible;
  /* The whole head leans toward what it is looking at. */
  transform: translate(calc(var(--ndc-look-x) * 6%), calc(var(--ndc-look-y) * 5%))
    rotate(calc(var(--ndc-look-x) * 10deg));
  transform-origin: 50% 80%;
  filter: drop-shadow(0 0 6px var(--ndc-glow, transparent))
    drop-shadow(0 0 calc(var(--ndc-light) * 12px) var(--ndc-glow, transparent));
}
.ndc-no-jaw { --ndc-light: max(var(--ndc-signal), var(--ndc-jaw)); }
.ndc-pupil {
  transform: translate(
    calc(var(--ndc-look-x) * var(--ndc-reach-x, 12px)),
    calc(var(--ndc-look-y) * var(--ndc-reach-y, 10px))
  );
}
.ndc-lid { transform-box: fill-box; transform-origin: 50% 0; transform: scaleY(var(--ndc-lid)); }
.ndc-crease { opacity: 0; }
.ndc.is-shut .ndc-crease { opacity: 1; }
.ndc.is-shut .ndc-dim { opacity: 0.45; }
.ndc-jaw { transform: translateY(calc(var(--ndc-jaw) * var(--ndc-drop, 14px))); }
.ndc-on { opacity: calc(0.25 + var(--ndc-light) * 0.75); }
.ndc-sig { opacity: var(--ndc-light); }
.ndc-soft { opacity: calc(var(--ndc-light) * 0.4); }
.ndc-grow {
  transform-box: fill-box;
  transform-origin: 50% 50%;
  transform: scale(calc(0.75 + var(--ndc-light) * 0.75));
}
.ndc[data-mood="asleep"] .ndc-svg { filter: saturate(0.55) brightness(0.8); }

/* The frog was drawn before the shared part names, so it keeps its own. */
.ndf-svg {
  filter: drop-shadow(0 0 6px rgb(183 255 26 / 0.35))
    drop-shadow(0 0 calc(var(--ndc-signal) * 16px) rgb(0 229 255 / 0.7));
}
.ndf-socket { fill: #060907; }
.ndf-nostril { fill: #07140d; }
.ndf-mouth { fill: #030504; }
.ndf-jaw { transform: translateY(calc(var(--ndc-jaw) * 40px + var(--ndc-signal) * 6px)); }
.ndf-throat-glow { opacity: calc(0.08 + var(--ndc-signal) * 0.9); }
.ndf-vee { fill: none; stroke: #00e5ff; stroke-width: 4.5; stroke-linecap: round; }
.ndf-vee-soft { fill: none; stroke: #00e5ff; stroke-width: 16; opacity: calc(0.14 + var(--ndc-signal) * 0.6); }
.ndf-pupil { transform: translate(calc(var(--ndc-look-x) * 17px), calc(var(--ndc-look-y) * 13px)); }
.ndf-glint { transform: translate(calc(var(--ndc-look-x) * -5px), calc(var(--ndc-look-y) * -4px)); }
.ndf-lid { transform-box: fill-box; transform-origin: 50% 0; transform: scaleY(var(--ndc-lid)); }
.ndf-crease { opacity: 0; }
.ndc.is-shut .ndf-crease { opacity: 1; }

@keyframes nd-open { from { opacity: 0; transform: translateY(14px) scale(0.97); } }
@keyframes nd-close { to { opacity: 0; transform: translateY(10px) scale(0.98); } }
@keyframes nd-rise { from { opacity: 0; transform: translateY(8px); } }
@keyframes nd-blink { 0% { opacity: 0.2; } 100% { opacity: 1; } }
@keyframes nd-pulse { 50% { transform: scale(1.08); } }

/* A phone gets the whole screen, and the mascot moves inside the header. */
@media (max-width: 520px) {
  .nd-panel {
    position: fixed;
    inset: 0;
    width: auto;
    height: auto;
    filter: none;
  }
  .nd-edge { padding: 0; }
  .nd-edge, .nd-surface { clip-path: none; border-radius: 0; }
  .nd-header { min-height: 84px; padding-top: max(12px, env(safe-area-inset-top)); }
  .nd[data-mascot] .nd-header { padding-left: 112px; }
  .nd-perch { left: 14px; top: max(10px, env(safe-area-inset-top)); width: 84px; }
  .nd-footer { padding-bottom: max(12px, env(safe-area-inset-bottom)); }
  .nd[data-open] .nd-launcher { display: none; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
  .ndc-svg { transform: none; }
}
`;
