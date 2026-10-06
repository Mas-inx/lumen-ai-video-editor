---
name: motion-graphic-styles
description: Use when a motion graphic, intro, explainer, ident or animated sequence should have a recognisable look — flat vector, line art, isometric, shape morph, Bauhaus, sticker explainer or variety captions — or when you have to choose a look. How to pick one style and hold it from the first frame to the last.
---

# Motion graphic styles: pick one, hold it

A piece looks designed when every frame obeys one style's rules, and generic when it borrows a little from several. This skill is for style-led pieces (intros, explainers, idents, animated sequences), usually built with render_hyperframes_html. A plain title or lower third over footage needs no named style: motion-design-craft is enough.

## Choose

Use the style the user names. Otherwise match the content, and tell the user which one you picked.

| Style | Pick it for |
|---|---|
| Flat vector | product and SaaS explainers, friendly brand pieces |
| Line art | luxury, finance, architecture, logo reveals |
| Isometric | systems, cities, app features, architecture diagrams |
| Shape morph | one idea turning into the next; premium explainers |
| Bauhaus | kinetic posters, events, anything led by the music |
| Sticker explainer | fact-dense knowledge videos with photos and charts |
| Variety captions | vlogs, pets, reactions, comedy: captions over footage |

Eight more are in `use_skill("motion-graphic-styles-textured")`: line boil (frame by frame), collage, liquid, synthwave / VHS, aurora glass, pixel art, HUD and soft 3D render.

## Hold it

- Write the style sheet before any code: the palette as hex values (a fixed count), line weight, corner radius, one ease per role, frame stepping, texture. Nothing outside it enters the piece.
- A style overrides motion-design-craft's "Never" list only for the features that style names. Reading time, hierarchy, safe margins and beat timing still apply.
- Each "Avoid" line is what turns the style generic. Treat it as a rule.
- Frame counts are at 30 fps (1 frame = 33 ms). Scale them to the project's fps.
- Check with get_frame at three moments: could someone name the style from that one frame? If not, the frame breaks the sheet.

## Flat vector

- **Look:** solid fills only. 5–6 saturated colours on one calm ground, e.g. #2B2BFF, #FF5A4E, #FFC62B, #2EE6A8, cream #FFF6E9, ink #151433. Geometric shapes and characters, no outlines, plenty of empty space.
- **Motion:** every entrance has three phases: 2–3 frames of anticipation, the move, an overshoot that settles (`CustomEase` "0.34,1.56,0.64,1" or `back.out(1.6)`). About 10% squash and stretch on launches and landings. Stagger siblings by 2–4 frames; one hero moves at a time. Limbs rotate around joint anchors.
- **Transitions:** a shape grows to fill the frame, or an object flies out and carries the cut.
- **Avoid:** gradients, shadows, blur, texture, crossfades.
- **Sound:** upbeat pop near 120 BPM; a pop or whoosh on each entrance.

## Line art

- **Look:** one line colour on one ground, e.g. champagne #E9D7A5 on midnight #0B1320. One stroke width for the whole piece (2–4 px), round caps. Most of the frame stays empty.
- **Motion:** lines draw themselves (DrawSVG, or `stroke-dashoffset` from the path length to 0) with "0.65,0,0.35,1", slowing into corners. Tell it as one continuous line: the end of each figure is the start of the next. A slow camera drift follows the pen tip, then pulls back to show the whole drawing. Lines already drawn dim to about 35%.
- **Hero moment:** line to fill. Once an outline closes, its fill grows from one anchor point.
- **Type:** a thin serif or light sans, tracked +15% to +25%, faded up last.
- **Avoid:** a second line weight, fills before the hero moment, several lines drawing at once.
- **Sound:** sparse piano or strings; a soft chime on the fill.

## Isometric

- **Look:** a miniature world with no vanishing point. Verticals stay vertical; floor axes run at ±30°. Build faces with transforms: top `rotate(30deg) skewX(-30deg) scaleY(0.866)`, left side `skewY(30deg) scaleX(0.866)`, right side `skewY(-30deg) scaleX(0.866)`. Three tones per colour (top lightest, right darkest), a pastel palette, soft contact shadows.
- **Motion:** things build. The base lands, walls grow with `scaleY` from 0 (origin at the bottom) and a small overshoot, the roof caps them 2–3 frames later. Tiles arrive as a wave from the centre. The camera only slides, never rotates; background, middle and foreground move at 0.6 : 0.8 : 1. Draw order follows screen y: lower is in front.
- **Type:** on the floor plane (top-face transform), or flat outside the world.
- **Avoid:** perspective, a rotating camera, light from two directions.
- **Sound:** bright plucked melody; a soft click for each landing.

## Shape morph

- **Look:** one hero shape in flat fills; the background colour changes with each form. Silhouettes simple enough to read as icons.
- **Motion:** MorphSVGPlugin between paths. Never morph a complex A straight into B: go A → circle or capsule → B, 8–12 frames each, eased "0.7,0,0.3,1" with a 3-frame cushion at both ends. Add 10–15% squash and stretch and a small rotation to hide the interpolation. Sub-parts change with the hero (steam → sun rays → waves). Land each new form on a beat.
- **Check:** get_frame at the middle of every morph. A knotted or self-crossing outline means: change `shapeIndex` or add the intermediate shape.
- **Avoid:** crossfading between shapes, two heroes.
- **Sound:** plucked arpeggio; a pitched whoosh for each morph.

## Bauhaus

- **Look:** circles, half and quarter circles, triangles, squares, bars. Red #E03C31, yellow #F2B705, blue #1E4FA3, black #111 on cream #F1E9DA. A strict module grid (e.g. 120 px); every size is a whole number of modules.
- **Motion:** one action per beat (0.5 s at 120 BPM): slide a whole number of modules, rotate 90° or 180°, flip, split. Every landing sits on a grid line. Alternate the pivot: own centre, a corner, the frame centre. Ease `power2.inOut` or linear.
- **Type:** heavy geometric sans, uppercase, on the grid (vertical setting fits), plus one small tracked caption.
- **Avoid:** overshoot, bounce, off-grid positions, a fifth colour, gradients, organic curves.
- **Sound:** minimal techno or clicks at the grid tempo; one pitched click per move.

## Sticker explainer

- **Look:** photo cut-outs made into stickers with the same 8–12 px white outline and a soft, close shadow; flat icons; exact charts; leader lines to labels. A calm ground (#E9EEF2), slate text, 2–3 colours and one accent (e.g. #FF5A36). One even-weight sans, strict alignment.
- **Motion:** lay everything out on one canvas several screens wide; a single wrapper pans and zooms from point to point with long `power3.inOut` moves (0.8–1.2 s). Each sentence brings one new element. Bars grow from the baseline to scale, numbers count up in tabular figures, routes draw on. End by pulling out to a type card: one huge number, one small caption.
- **Avoid:** cuts between scenes, decorative motion, charts not to scale, numbers that disagree.
- **Sound:** light, clean bed; clicks on entrances, ticks under count-ups, a soft whoosh on camera moves.

## Variety captions

- **Look:** captions that react to the footage. Rounded heavy type (Google Fonts Fredoka or Baloo 2) in three layers: a bright fill, a white stroke of 8–14 px, a coloured outer stroke or hard shadow (`-webkit-text-stroke` with `paint-order: stroke fill` on stacked copies). Pink, yellow, cyan and white. Drawn extras: burst frames with radial lines, sweat drops, sparkles, question marks, a stamp.
- **Motion:** pop from scale 0 to 1.15 to 1 in about 8 frames, or bounce character by character with a 2-frame stagger, tilted a few degrees. Appear 2–3 frames after the moment they react to. Wiggle gently while held (±1.5°, ±2 px). Punch the footage in on the moment (clip_animate `punch`).
- **Match the emotion:** shock gets a burst frame; awkward gets a sweat drop and a small aside in brackets; praise gets sparkles.
- **Avoid:** thin type, two captions at once, a caption that arrives before its moment.
- **Sound:** a bouncy bed; a pop, boing or ding with each caption.
