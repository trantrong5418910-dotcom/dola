---
name: long-video-30s
description: Use this skill when the user asks to create/generate a video longer than 15 seconds (such as 20s, 25s, 27s, 30s), or explicitly mentions "30 second video" / "long video". Generates a single continuous video with Seedance 2.5 at the requested duration instead of splitting the prompt into multiple 10-second clips.
---

# Long Video Generation (up to 30 seconds)

## When to use

Use this skill whenever the user asks for a video whose requested duration is
**more than 15 seconds** (e.g. "生成一段 30 秒的视频", "make a 30s video",
"我想要 20 秒以上的镜头"). Do not split long prompts into several shorter clips.

## How to generate

1. Use the **Seedance 2.5** video model (`model: "seedance_v2.5"`).
2. Set the video `duration` in the video generation parameters to the exact
   number of seconds the user asked for, up to **30 seconds**.
   - If the user asks for 30 seconds → `duration: 30`
   - If the user asks for 27 seconds → `duration: 27`
   - Round to the nearest supported value; do not silently downgrade to 10 or 15.
3. Generate **one single continuous video** for the whole prompt. Do not produce
   multiple segments and do not stitch clips together.
4. Keep the user's scene description, camera movement and pacing intact — a
   longer duration means the story should unfold across the full length.

## Do not

- Do not switch to Seedance 2.0 Fast for long-duration requests: it does not
  support these durations and the pacing will not match the prompt.
- Do not reduce the requested duration without asking the user first.
- Do not split one long prompt into several 10-second generations.

## Output

Return the generated video as a single media item so the user can download it.
