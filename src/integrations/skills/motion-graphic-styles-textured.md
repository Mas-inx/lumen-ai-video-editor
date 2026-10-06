---
name: motion-graphic-styles-textured
description: Use when a motion graphic should have a textured, retro or rendered look — frame-by-frame line boil, collage cut-out, liquid, synthwave / VHS, aurora glass, pixel art, HUD / sci-fi interface or soft 3D render. The rules that make each one read as that style, and what breaks it.
---

# Motion graphic styles: textured, retro and rendered

The second half of motion-graphic-styles. Load that skill first: it covers choosing a style and holding it (style sheet first, nothing outside it, every "Avoid" is a rule). Frame counts are at 30 fps.

Most of these styles need two techniques from hyperframes-compositions:
- **Stepped time:** motion snapped to a lower frame rate (12 fps = "on twos").
- **Seeded variation:** jitter, boil and grain from a seeded random keyed by the stepped frame number, so every render is identical.

## Line boil (frame by frame)

- **Look:** ink lines of uneven width on warm paper. 3–4 colours: ink black, tomato red, sunny yellow, cream. Fills sit 2–4 px off their outlines, like hand colouring. Paper texture over everything at 10–15% (`mix-blend-mode: multiply`).
- **Motion:** on twos (12 drawings a second); fast actions on ones, holds on threes. Lines boil: 3–4 slightly different versions of each drawing (points moved 2–3 px by seeded noise), swapped every 2 frames, during holds too. In SVG: `feTurbulence` + `feDisplacementMap` (scale 3–5) with the `seed` stepped. A fast move gets one smear frame: the shape stretched 150–300% along its path for a single frame. Add drawn effects: smoke puffs, sparks, star bursts, speed lines.
- **Avoid:** smooth tweens, perfect vector edges, a hold that goes completely still.
- **Sound:** playful jazz or pizzicato; a cartoon effect on each action.

## Collage

- **Look:** photo cut-outs with a rough 2–4 px white scissor edge and halftone dots, on kraft or newsprint. Torn strips, tape, scribbles. Bold red and black type on diagonals. Proportions are wrong on purpose (huge head, tiny body). Layers, back to front: paper, big colour shapes, cut-outs, scribbles and tape, grain.
- **Motion:** stepped at 12 fps, some holds at 6. Each new pose shifts ±2 px and ±0.5°, as if placed by hand. Joints turn at the shoulder, elbow and jaw like a paper puppet; mouths swap between 2–3 shapes. Elements are slapped on: full size at once, then a 2-frame squash.
- **Transitions:** a page flip or a tear.
- **Avoid:** eased slides, soft shadows, clean digital edges, correct proportions.
- **Sound:** vinyl crackle and boom-bap; paper rustles, scissor snips, slaps.

## Liquid

- **Look:** thick glossy liquid in 2–3 neighbouring hot colours (orange, pink, violet) on a deep ground (plum #2A0E2E), with a bright highlight and a lighter rim so it reads as volume. Every edge is a curve.
- **Fusion:** put the circles in one SVG group, blur it (`feGaussianBlur` 12–20), then sharpen alpha (`feColorMatrix`, alpha row `0 0 0 20 -8`). Shapes that come close join. Use this filter on that one group only.
- **Motion:** liquid is flung, never driven: "0.22,1,0.36,1". A part that leaves stretches a thin neck, which snaps; both ends rebound for 2–3 frames. Small drops follow 2–3 frames late and squash flat on landing. A transition is a wave front crossing the frame with 3–5 bulges out of phase.
- **Avoid:** straight edges, constant speed, flat blobs with no highlight, hard cuts.
- **Sound:** gloops, pours, splashes and drips over a glossy bed with a bass swell.

## Synthwave / VHS

- **Look:** a purple night sky, a striped sun (magenta to orange to yellow, horizontal bands cut out, wider toward the bottom), a magenta and cyan perspective grid rushing at the viewer, wireframe mountains, palm silhouettes. A chrome title: a hard-edged gradient (blue to white above the middle, a dark band on it, orange to yellow below), a bevel highlight, one glint crossing it. A pink neon script word that writes on and flickers.
- **Glow:** always two layers: tight (4 px, bright) and wide (30 px, faint).
- **VHS pass:** red and blue shifted 1–2 px apart, scanlines (2 px pitch, 10% black), 1–2 short tracking jolts a second, a "PLAY ▶" label. Step a few moments down to 15 fps for tape stutter.
- **Motion:** the grid scrolls at constant speed. The title slams in over 4–6 frames on a downbeat.
- **Type:** wide caps (Archivo at `font-stretch: 125%`, or Google Fonts Michroma); VT323 for labels.
- **Avoid:** pastels, flat clean UI, slow fades, the same glow on everything.
- **Sound:** synthwave near 100 BPM: arpeggiated bass, gated snare, a crash on the title.

## Aurora glass

- **Look:** an indigo-black ground with 3–5 large colour blobs blurred 80–150 px, in 2–3 neighbouring hues (violet, blue, cyan). Frosted cards: `backdrop-filter: blur(30px)`, white fill at 5–10%, a 1 px inner highlight of white at 30%, radius 24–40 px. Noise at 3–5% over everything to stop banding. A light, elegant sans.
- **Motion:** everything is slow. Blobs drift on curved paths in 20–40 s loops, `sine.inOut` or linear. Text and cards enter with opacity and an 8 px rise, nothing more. Cards float with slight parallax and a few degrees of tilt.
- **Avoid:** fast moves, bounces, opposite hues (they turn muddy), hard shadows, a light ground.
- **When:** only if asked for, or for an AI or tech product launch. It is the default look motion-design-craft warns against.
- **Sound:** ambient pad, soft shimmer, barely audible interface ticks.

## Pixel art

- **Look:** draw on a small canvas (320×180) and scale it by a whole number (×6 for 1920×1080) with `image-rendering: pixelated`. 16–32 colours; gradients are dithered. Sprites 16–24 px tall.
- **Motion:** sprite cycles at 8–12 fps (run 6–8 frames, idle 2–4). Positions are whole pixels of the small canvas; timing is `steps()`, no easing. 3–4 parallax layers scroll at different whole-pixel speeds. Text types on in a dialogue box.
- **Type:** a pixel font (Google Fonts Press Start 2P) at whole-pixel sizes.
- **Finish:** an optional CRT pass (scanlines, faint glow), light enough that pixels stay crisp.
- **Avoid:** anti-aliasing, sub-pixel moves, rotated or scaled sprites, smooth tweens, blur.
- **Sound:** chiptune (pulse lead, triangle bass, noise drums); jump and coin effects.

## HUD / sci-fi interface

- **Look:** thin cyan lines (#00E5FF, 1–2 px) on teal-black, and one alert colour (#FF6A00) kept for the lock moment. Hex grid, rings with tick marks, corner brackets, a crosshair, a radar sweep (`conic-gradient` sector), sparklines, columns of small data. Geist Mono, 12–16 px at 1080p, uppercase, tracked.
- **Motion:** build in layers: frame lines draw on, then panels, then data, staggered by hierarchy. Numbers roll random values for 3–5 frames, then settle on the real one. Status lines type on with a blinking cursor. Rings turn at constant speed. Lock brackets shrink from scale 1.4 to 1 in 6–8 frames (`power3.out`), then the interface flips to the alert colour.
- **Finish:** a tight glow on lines, scanlines, a 1 px colour fringe, a 2-frame glitch at most once every 2–3 s.
- **Avoid:** thick strokes, a third colour, bouncy eases, data that flickers at one rate forever.
- **Sound:** a dark synth pulse; beeps on data, a rising tone into the lock, an alarm on it.

## Soft 3D render

Tactile CGI: candy-coloured gummy and glossy plastic with one chrome or frosted-glass accent, a pastel seamless backdrop, large soft lights, shallow depth of field, motion blur. Rows of repeated objects ripple in waves; a hero object drops in, squashes and jiggles. Build it in Blender: `use_skill("blender-3d")`, section "Soft product look". Add the type as a 2D overlay.
