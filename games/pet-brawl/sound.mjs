// One bounded original-video cue per character; never loop or stack its casts.
export function createSkillVoice(media, enabled = true) {
  let on = enabled, resumePending = false;
  media.loop = false; media.volume = .45; media.playbackRate = 1;
  const play = () => Promise.resolve(media.play()).catch(() => {});
  const stop = () => { resumePending = false; media.pause(); try { media.currentTime = 0; } catch { /* Metadata may not be ready yet. */ } };
  media.addEventListener?.('ended', () => { resumePending = false; });
  return {
    play() { if (!on) return; stop(); play(); },
    pause() { resumePending ||= !media.paused && !media.ended; media.pause(); },
    resume() { if (on && resumePending) { resumePending = false; play(); } },
    stop,
    setEnabled(value) { on = Boolean(value); if (!on) stop(); },
  };
}
// Retain the existing whale cue API for its earlier tests and callers.
export const createWhaleVoice = createSkillVoice;
