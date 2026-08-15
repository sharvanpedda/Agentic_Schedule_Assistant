// Voice helpers — records mic audio in the browser and sends it to the
// backend, which calls Sarvam AI for speech-to-text and text-to-speech.
//
// This replaces the old approach of relying on the browser's built-in
// webkitSpeechRecognition/speechSynthesis (Web Speech API). That API only
// works in Chrome/Edge, often silently no-ops on http/insecure origins,
// mobile browsers, and Firefox/Safari — which is why voice looked "broken"
// for a lot of users. MediaRecorder + a server round-trip works everywhere
// that has a microphone.

import { api } from "./api";

/** True if this browser can record audio at all (mic capture). */
export function speechSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof window !== "undefined" &&
    "MediaRecorder" in window
  );
}

/**
 * How long the mic can go silent before we auto-stop and send whatever was
 * said. Without this, recording ran forever until the user tapped the
 * button again. 5s is a good default for a back-and-forth voice assistant —
 * long enough not to cut someone off mid-sentence, short enough that the
 * agent actually responds instead of listening indefinitely.
 */
export const SILENCE_TIMEOUT_MS = 5000;
/** How often we sample mic volume to decide whether the user is still talking. */
const SILENCE_CHECK_INTERVAL_MS = 200;
/** RMS amplitude (0–1) below which the mic is considered "silent". Tuned to
 * ignore normal room-noise floor but catch an actual voice. */
const SILENCE_AMPLITUDE_THRESHOLD = 0.02;
/**
 * Absolute safety cap: stop no matter what after this long, even if the
 * silence detector never fires (e.g. AudioContext got blocked/suspended by
 * the browser, or there's steady background noise keeping it above
 * threshold). This is what guarantees the mic can never "run forever" —
 * silence detection is the normal path, this is the backstop.
 */
const MAX_RECORDING_MS = 60_000;

/** True if this browser can play back audio (basically always). */
export function ttsSupported(): boolean {
  return typeof window !== "undefined" && "Audio" in window;
}

function pickMimeType(): string {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"];
  for (const c of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported?.(c)) return c;
  }
  return "";
}

/**
 * Record from the mic until stop() is called, OR the mic has been silent for
 * SILENCE_TIMEOUT_MS (whichever comes first) — then upload the clip to
 * /api/voice/stt and resolve with the transcript. This is what makes voice
 * turn-taking work like a real conversation instead of recording forever:
 * the user stops talking, and after a short pause the agent just answers.
 * Returns a stop() function you can still call manually (e.g. a "stop"
 * button tap) to end the turn early.
 */
export function startListening(
  token: string,
  onResult: (text: string) => void,
  onEnd: () => void,
  onError?: (msg: string) => void
): () => void {
  let recorder: MediaRecorder | null = null;
  let stream: MediaStream | null = null;
  let stopped = false;
  let audioCtx: AudioContext | null = null;
  let silenceCheckId: number | null = null;
  let hardCapId: number | null = null;
  let lastSoundAt = Date.now();

  const cleanup = () => {
    if (silenceCheckId !== null) {
      window.clearInterval(silenceCheckId);
      silenceCheckId = null;
    }
    if (hardCapId !== null) {
      window.clearTimeout(hardCapId);
      hardCapId = null;
    }
    if (audioCtx) {
      audioCtx.close().catch(() => {});
      audioCtx = null;
    }
    stream?.getTracks().forEach((t) => t.stop());
  };

  const stopRecorder = () => {
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
    } else {
      cleanup();
    }
  };

  navigator.mediaDevices
    .getUserMedia({ audio: true })
    .then((s) => {
      if (stopped) {
        s.getTracks().forEach((t) => t.stop());
        return;
      }
      stream = s;
      const mimeType = pickMimeType();
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const chunks: BlobPart[] = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      recorder.onstop = async () => {
        cleanup();
        onEnd();
        if (!chunks.length) {
          // Recorder stopped (e.g. hard-cap fired, or the user tapped
          // stop instantly) with nothing actually captured. There's no
          // upload to make, so nothing will ever call onResult/onError
          // for this turn — surface it explicitly instead of leaving the
          // caller stuck in whatever state onEnd() just set.
          onError?.("Didn't catch any audio — try again.");
          return;
        }
        const blob = new Blob(chunks, { type: mimeType || "audio/webm" });
        try {
          const text = await api.speechToText(token, blob);
          if (text) onResult(text);
          else onError?.("Didn't catch that — try again.");
        } catch (e: any) {
          onError?.(e?.message || "Voice transcription failed.");
        }
      };
      recorder.onerror = () => {
        cleanup();
        // Same ordering requirement as the getUserMedia rejection above —
        // onEnd() must run before the terminal onError() so `listening`
        // is cleared rather than left stuck true.
        onEnd();
        onError?.("Recording error — try again.");
      };
      recorder.start();

      // Absolute backstop — fires regardless of whether silence detection
      // below ever manages to start. Guarantees no infinite recording.
      hardCapId = window.setTimeout(() => stopRecorder(), MAX_RECORDING_MS);

      // --- silence detection: sample mic volume, auto-stop after a pause ---
      try {
        const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
        audioCtx = new AudioCtx();
        // Some browsers (notably Safari/iOS) create contexts in a
        // "suspended" state unless resume() is called explicitly, even
        // from within a user-gesture-triggered handler — without this the
        // analyser silently reports nothing and silence is never detected.
        audioCtx.resume?.().catch(() => {});
        const source = audioCtx.createMediaStreamSource(stream);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        const data = new Uint8Array(analyser.frequencyBinCount);
        lastSoundAt = Date.now();

        silenceCheckId = window.setInterval(() => {
          analyser.getByteTimeDomainData(data);
          // RMS deviation from the silent midpoint (128) -> 0..1 amplitude
          let sumSquares = 0;
          for (let i = 0; i < data.length; i++) {
            const v = (data[i] - 128) / 128;
            sumSquares += v * v;
          }
          const rms = Math.sqrt(sumSquares / data.length);
          if (rms > SILENCE_AMPLITUDE_THRESHOLD) {
            lastSoundAt = Date.now();
          } else if (Date.now() - lastSoundAt > SILENCE_TIMEOUT_MS) {
            stopRecorder();
          }
        }, SILENCE_CHECK_INTERVAL_MS);
      } catch (e) {
        // Web Audio API unavailable/blocked — recording still works and the
        // hard cap above still guarantees it stops, it just won't auto-stop
        // on silence specifically. Logged so this is diagnosable in the
        // field instead of silently degrading.
        console.warn("Voice silence-detection unavailable, falling back to the hard cap:", e);
      }
    })
    .catch(() => {
      // Order matters: onEnd() must run first so the caller drops out of
      // "listening" before the terminal onError() fires — otherwise a
      // caller that sets transcribing=true inside onEnd (to reflect "the
      // recording phase is over") would have that overwrite the failure
      // state set here.
      onEnd();
      onError?.("Couldn't access the microphone. Check browser permissions.");
    });

  return () => {
    stopped = true;
    stopRecorder();
  };
}

let currentAudio: HTMLAudioElement | null = null;
let currentUrl: string | null = null;

/** Fetch server-side TTS for `text` and play it. onStart/onEnd track state. */
export async function speak(
  token: string,
  text: string,
  onStart?: () => void,
  onEnd?: () => void
): Promise<void> {
  if (!ttsSupported() || !text.trim()) return;
  stopSpeaking();
  try {
    const url = await api.textToSpeech(token, text);
    currentUrl = url;
    const audio = new Audio(url);
    currentAudio = audio;
    audio.onplay = () => onStart?.();
    audio.onended = () => {
      onEnd?.();
      if (currentUrl === url) {
        URL.revokeObjectURL(url);
        currentUrl = null;
      }
    };
    audio.onerror = () => onEnd?.();
    await audio.play();
  } catch {
    onEnd?.();
  }
}

export function stopSpeaking(): void {
  if (currentAudio) {
    try {
      currentAudio.pause();
    } catch {
      /* ignore */
    }
    currentAudio = null;
  }
  if (currentUrl) {
    URL.revokeObjectURL(currentUrl);
    currentUrl = null;
  }
}

export function isSpeaking(): boolean {
  return !!currentAudio && !currentAudio.paused && !currentAudio.ended;
}
