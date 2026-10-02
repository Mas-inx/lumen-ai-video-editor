---
name: short-form-editing
description: Use when cutting Reels, TikToks, Shorts or any vertical / social edit — hooks, pacing, captions, reframing and retention.
---

# Short-form editing

Short-form lives or dies in the first 1–2 seconds and on rhythm. Edit for a viewer who is one thumb-flick from leaving.

## Set up

- **Frame.** 1080×1920 for vertical. `reframe` converts an existing edit, and `sequence_create` makes a 9:16 version alongside it. Keep faces and action in the centre 60% and away from the UI zones: the top 12%, the bottom 20%, and the right edge where buttons sit.
- **Know the material.** get_transcript for talking content, get_contact_sheet to see the footage, analyze_audio for loudness and silences.

## The hook

- Open on the most interesting moment: the payoff, a bold claim, a striking visual, a question. You can move it to the front and come back.
- Put on-screen text in the first frame that states the hook in under 7 words (add_title, or render_motion_graphic kinetic / title-card poster).
- No logos, slow fades or "hey guys" openings.

## Pace

- **Remove pauses and filler.** find_pauses / remove_pauses; keep breaths that carry emotion.
- **Change something every 1–3 seconds:** a cut, a punch-in (scale 1.0 → 1.15 on the same shot), a b-roll insert, or text.
- **Cut on the beat** if there's music (the motion-design-craft rhythm rules apply):
  - detect_beats gives the beat times;
  - cut_to_beats lays b-roll out on them (1–2 beats per clip for energy);
  - land the hook's last word, reveals and transitions on beats.
- **Use punch-ins with intent:** in on emphasis, out on context (clip_animate `punch` at a beat, or a scaled cut). Hard cuts beat animated zooms. Use speed ramps sparingly, on action.
- **Keep transitions mostly hard cuts.** A whip, push or match cut at most once or twice per video.

## Captions

- Add captions to anything with speech; most people watch muted (`add_captions`).
- Pick the style for the piece:
  - `bold`: big outlined caps, 3 words at a time, popping in. The default for short-form.
  - `word`: one word at a time, key words in the `accent` colour. For punchy, fast talkers.
  - `boxed`: solid boxes. Good on busy footage.
  - `clean`: classic subtitles. For interviews and long-form.
- Keep them short: 1–4 words at a time, big and high-contrast, in the safe area (lower-middle). Emphasise key words with the accent colour or weight, not with emoji soup. Choose an accent that suits the grade, not always yellow.
- Captions must be timed to the words. Spot-check them with get_frame.

## Sound

- Music sits under the voice and ducks while people talk (`duck_music`). Speech carries the edit.
- Use sound effects on cuts, punch-ins and text hits (whooshes, risers, clicks), quietly: they should be felt more than heard.
- Loudness for social is around −14 LUFS integrated. Check with analyze_audio and set it on export.

## End

- End on a strong line or a loop point (the last frame flows back into the first), not a fade to black.
- Make any call to action specific and short.

## Check

Watch the whole edit (get_contact_sheet), check the hook frame, the first 3 seconds and caption legibility, and fix anything that drags.
