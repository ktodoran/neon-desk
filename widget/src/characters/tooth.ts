import type { Character } from './index.js';

// The tooth. Signal light: the glint beside it. It has no mouth, so the glint
// flickers while it speaks.
// prettier-ignore
const SVG =
  '<svg viewBox="40 0 500 470" xmlns="http://www.w3.org/2000/svg"><polygon fill="#eef6fa" points="280,76 206,38 134,50 88,110 74,200 88,282 106,352 122,420 152,458 196,440 226,380 250,332 280,320 310,332 334,380 364,440 408,458 438,420 454,352 472,282 486,200 472,110 426,50 354,38"/><polygon fill="#ffffff" points="206,38 280,76 280,128 154,114 134,50"/><polygon fill="#ffffff" points="426,50 406,114 280,128 280,76 354,38"/><polygon fill="#d5e6ef" points="134,50 88,110 74,200 88,282 144,254 154,114"/><polygon fill="#eef6fa" points="406,114 416,254 472,282 486,200 472,110 426,50"/><polygon fill="#ffffff" points="154,114 280,128 280,320 250,332 144,254"/><polygon fill="#ffffff" points="416,254 310,332 280,320 280,128 406,114"/><polygon fill="#b7d2df" points="88,282 106,352 122,420 152,458 174,362 144,254"/><polygon fill="#d5e6ef" points="416,254 386,362 408,458 438,420 454,352 472,282"/><polygon fill="#97bccd" points="144,254 174,362 152,458 196,440 226,380 250,332"/><polygon fill="#b7d2df" points="310,332 334,380 364,440 408,458 386,362 416,254"/><polygon fill="#d5e6ef" points="232,106 280,128 328,106 280,92" style="opacity:0.7"/><polygon fill="#17b8a6" points="446,12 456.6,67.4 512,78 456.6,88.6 446,144 435.4,88.6 380,78 435.4,67.4" class="ndc-soft"/><polygon fill="#0d6e64" points="446,32 452.4,71.6 492,78 452.4,84.4 446,124 439.6,84.4 400,78 439.6,71.6"/><polygon fill="#17b8a6" points="446,32 452.4,71.6 492,78 452.4,84.4 446,124 439.6,84.4 400,78 439.6,71.6" class="ndc-on"/><polygon fill="#e9fffb" points="446,60 448.8,75.2 464,78 448.8,80.8 446,96 443.2,80.8 428,78 443.2,75.2" class="ndc-sig"/><g class="ndc-pupil"><rect x="228" y="181" width="20" height="46" rx="10" fill="#0f2630"/></g><rect x="214" y="167" width="48" height="74" fill="#ffffff" class="ndc-lid"/><path fill="none" stroke="#0f2630" d="M223 221 L253 221" class="ndc-crease" style="stroke-width:6px;stroke-linecap:round"/><g class="ndc-pupil"><rect x="312" y="181" width="20" height="46" rx="10" fill="#0f2630"/></g><rect x="298" y="167" width="48" height="74" fill="#ffffff" class="ndc-lid"/><path fill="none" stroke="#0f2630" d="M307 221 L337 221" class="ndc-crease" style="stroke-width:6px;stroke-linecap:round"/></svg>';

export const TOOTH: Character = {
  id: 'tooth',
  name: 'Pearl',
  svg: SVG,
  look: { x: 14, y: 10 },
  glow: 'rgb(23 184 166 / 0.38)',
  plate: { ground: '#0a3338', edge: ['#17b8a6', '#d5e6ef'] },
};
