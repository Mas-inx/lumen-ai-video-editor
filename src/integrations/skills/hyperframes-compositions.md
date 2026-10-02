---
name: hyperframes-compositions
description: Use when writing a custom HyperFrames composition (render_hyperframes_html) — the page structure Lumen needs, the fonts and GSAP plugins available, and techniques for crafted, frame-exact motion.
---

# Writing HyperFrames compositions for Lumen

render_hyperframes_html renders your HTML page frame by frame into a transparent clip. Follow the motion-design-craft skill for taste. This skill covers mechanics.

## The page

```html
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta data-composition-id="main" data-width="1920" data-height="1080">
  <script src="https://cdn.jsdelivr.net/npm/gsap@3/dist/gsap.min.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 1920px; height: 1080px; overflow: hidden; background: transparent; }
    .clip { position: absolute; inset: 0; visibility: hidden; }
  </style>
</head>
<body>
  <div class="clip" data-start="0" data-duration="5" data-track-index="0">
    <!-- your graphic -->
  </div>
  <script>
    const tl = gsap.timeline({ paused: true });
    // …tweens…
    window.__timelines = window.__timelines || {};
    window.__timelines["main"] = tl;
  </script>
</body>
</html>
```

- **Composition id.** The `data-composition-id` must match the key in `window.__timelines`.
- **Timeline.** It must be paused; Lumen seeks it frame by frame. Never rely on real time: no `setTimeout`, `requestAnimationFrame` loops, CSS animations or transitions, and no video `autoplay`.
- **Clips.** Timed elements carry `class="clip"` with `data-start`, `data-duration` and `data-track-index`. The runtime shows each one only during its window.
- **Size.** Size the page to the project (get_project → settings.width × height); vertical projects are 1080×1920.
- **Background.** Keep the background transparent for overlays. Paint one only when the graphic is a full-frame card.
- **Determinism.** Same time, same frame. Seed any randomness (e.g. `let s = 7; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647`).

## Fonts

Lumen injects its typefaces into every composition:

| Family | Character |
|---|---|
| `Fraunces` | variable serif with optical size; italic too |
| `Instrument Serif` | elegant; italic too |
| `Bricolage Grotesque` | characterful grotesk |
| `Syne` | art-directed display |
| `Archivo` | variable width: `font-stretch` 62%–125% |
| `Space Grotesk` | technical |
| `Geist` | neutral labels |
| `Geist Mono` | numbers and data |

- Use them by name. They need no download and work offline.
- Google Fonts also work through a `<link>` to fonts.googleapis.com, when the computer is online. Pick a family for its voice, not by habit.
- Set type deliberately:
  - `font-kerning: normal`;
  - `text-wrap: balance` for headings;
  - `font-variant-numeric: tabular-nums` for counters;
  - `font-variation-settings: 'opsz' 144` for big Fraunces.

## GSAP

GSAP 3 and all its plugins are bundled. Lumen swaps any cdn.jsdelivr.net/npm/gsap… script for its local copy, so load plugins the same way:
- SplitText
- CustomEase
- DrawSVGPlugin
- MorphSVGPlugin
- MotionPathPlugin
- ScrambleTextPlugin
- Flip

Techniques that read as crafted:

- **Masked reveals.** Wrap each line or word in `overflow: hidden` and slide the inner span from `yPercent: 110` to 0 with `expo.out`. SplitText with `mask: "lines"` does this for you.
- **Clip-path wipes.** Animate `clipPath` from `inset(0 100% 0 0)` to `inset(0 0% 0 0)`.
- **Drawing lines.** Animate `scaleX` from 0 with `transform-origin: left`, or use DrawSVG on a path.
- **Variable fonts.** Animate `fontStretch` (Archivo), `fontWeight`, or `fontVariationSettings`.
- **Custom easing.** `CustomEase.create("settle", "M0,0 C0.16,1 0.3,1 1,1")` for a precise feel. Name eases by role: `enter`, `exit`, `draw`, `camera`.
- **Position parameters.** Use absolute times or labels (`tl.addLabel("hit", 1.25)`) so moments land on the music's beats: beat times = offset + n × 60 / bpm.
- **Staggers.** `stagger: { each: 0.05, from: "start" }` for reading order. `from: "center"` only when the shape is symmetric.

## Avoid

- Filters on large layers (blur, drop-shadow on full-frame elements): slow to render and the stock look.
- `box-shadow` glows, `backdrop-filter`, gradient text by default.
- Animating `top`/`left`/`width` (use transforms); layouts that depend on the viewport (use the page's px size).

## Check

- After rendering, look at it with get_frame at the end of the entrance, the middle of the hold and the exit.
- If it lands on the timeline over footage, check legibility over the actual frames.
