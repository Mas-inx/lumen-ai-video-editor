---
name: motion-design-craft
description: Use for any title, lower third, kinetic type, intro, end card, motion graphic or HyperFrames composition — the craft rules that keep it from looking like generic AI video.
---

# Motion design craft

The bar: it should look like a considered studio made it for this film — not like a template, and never like "AI video". Every choice is deliberate and specific to the footage, the brand and the music.

## Never (unless the user asks for it, or the brief genuinely needs it)

- Glassmorphism, frosted-glass panels, blurred translucent cards.
- Floating cards that slide up from below; things that bounce in for no reason.
- Gradient blobs, aurora backgrounds, neon glows, glints and shimmer sweeps, glowing gradient strokes.
- Default fonts used without thought (system-ui, Arial, Inter or Geist as the display face). Choose type on purpose.
- The stock HyperFrames / Remotion look: everything fades and slides 40 px with the same ease and duration; blur-in letters; scale-and-blur pops; drop shadows on everything.
- Everything moving at once. Text that leaves before it can be read. Motion with no reason.

## Typography

- Pick a typeface for the job and the film's voice:
  - Editorial, elegant, documentary: an editorial serif. Lumen ships Fraunces (`editorial`) and Instrument Serif (`serif`).
  - Energetic, contemporary, brand: a characterful grotesk. Lumen ships Bricolage Grotesque (`display`) and Syne (`art`).
  - Kinetic type: a variable-width family. Lumen ships Archivo (`wide`); animate `font-stretch` from 62% to 125%.
  - Technical, data, UI: Space Grotesk (`tech`), with Geist Mono for numbers and labels.
  - Supporting labels: Geist (`sans`), small, uppercase and tracked.
- Use one display face, plus at most one supporting face.
- Set it properly:
  - Tighten large display type (−1% to −4% tracking).
  - Open up small caps and labels (+12% to +24%, uppercase).
  - Use tabular figures for numbers that change.
  - Use real quotes and dashes (“ ” — –).
- Break lines on meaning ("The quiet | hour"), not on width; avoid a single orphan word on the last line (`text-wrap: balance`).
- Build hierarchy from scale and weight contrast, not from boxes and colours.
- Keep text inside the title-safe area (the central 90%). Margins are 5–8% of the frame's short side and the same on every graphic.

## Easing: a different curve for each element's role

- Entrances decelerate.
  - Hero type: `expo.out` or `power4.out` (fast start, long settle) over 0.8–1.2 s.
  - Supporting text: `power2.out`, 0.5–0.7 s, starting 120–250 ms after the hero.
  - Rules and lines draw with `power3.inOut`.
  - Small accents may overshoot slightly: `back.out(1.2–1.6)`. Only one element per graphic.
- Exits accelerate (`power2.in`, `power3.in`) and are shorter than entrances (about 60%). Stagger them in reverse order.
- Camera-like moves (push-ins, pans, drifts): `sine.inOut`, `power1.inOut` or linear, long and continuous.
- Never give every element the same ease and duration; offset starts so the eye is led in reading order.
- Reveal type with masks (a word slides inside a clipped line, or a clip-path wipe) rather than fades. Type that wipes on reads as crafted; type that fades reads as default.

## Timing and holds

- Hold text long enough to read twice: about 0.3 s per word plus 1 s once it has fully landed, never under 1.5 s.
- Motion is at most about 30% of a graphic's life; the rest is hold.
- A hold can breathe (a 1–3% scale drift, linear), but nothing should pull the eye while people read.
- Entrances take 0.5–1.1 s; exits 0.3–0.6 s.

## Rhythm: cut to the music

- With music, find its tempo and beats (detect_beats gives the BPM and every beat's time) and land the key moments on beats:
  - word changes, reveals, hits, cuts into and out of graphics;
  - a graphic arriving 1–2 frames before the beat feels on it.
- Pass `bpm` to render_motion_graphic for kinetic type and poster titles; punch-ins are clip_animate `punch` at a beat's frame; cut_to_beats lays a montage out on the beat.
- Use every beat for energetic edits, every other beat or every bar for calm ones.

## Camera moves with intent

- Every move has a reason:
  - push in to focus or build tension;
  - pull out to reveal context;
  - pan to connect two subjects;
  - follow a subject.
- Use one move per shot: slow and continuous beats fast and nervous.
- Use keyframes (`keyframe_set`) with easing that matches the move's purpose; finish moves before the cut, or hold through it on purpose.

## Colour and composition

- Take colour from the footage or the brand: look at frames first (get_frame / get_contact_sheet). Use one accent, sparingly.
- Prefer solid fills to gradients. Legibility comes from placement and a soft, close shadow (or a solid band), never a frosted panel.
- Align everything to a grid and keep margins consistent. Make asymmetry deliberate: a lower third sits on the lower-left third, a title holds the optical centre.

## Workflow

1. Write the idea in one line: what should the viewer feel or understand?
2. Choose the system before rendering:
   - typeface and weights;
   - one accent colour from the footage;
   - an ease for each element role;
   - holds from reading time;
   - beat timing if there's music.
3. Make it: render_motion_graphic (pick a style, font, accent and bpm on purpose), or render_hyperframes_html for something bespoke (use_skill hyperframes-compositions).
4. Check it: get_frame at the end of the entrance, mid-hold and the start of the exit. Fix anything that looks templated, cramped, off-grid or too short to read before you say you're done.
