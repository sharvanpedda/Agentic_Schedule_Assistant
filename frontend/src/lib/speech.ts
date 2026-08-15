// Voice helpers.
//
// Speech-to-text uses the browser's own built-in recognizer (Web Speech
// API) — free, in-browser, no API key, no server round-trip. It ran through
// a MediaRecorder-upload-to-Sarvam pipeline for a while, which turned out to
// be a much bigger source of failure (custom silence detection, a 60s hard
// cap, a network hop through our backend to a third-party STT key that has
// to actually be valid/funded) for very little benefit — the browser's
// recognizer already has its own end-of-speech detection built in, so none
// of that machinery is needed. Solid support in Chrome/Edge; partial in
// Safari, and Firefox doesn't support it at all — speechSupported() guards
// for that so the mic button just doesn't show up rather than silently
// failing.
//
// Text-to-speech (below, speak/stopSpeaking/isSpeaking) is unrelated to
// this and still goes through the backend to Sarvam AI — untouched here.

import { api } from "./api";

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;
interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((e: any) => void) | null;
  onerror: ((e: any) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  return (
    (window as any).SpeechRecognition ||
    (window as any).webkitSpeechRecognition ||
    null
  );
}

/** True if this browser has a built-in speech recognizer available. */
export function speechSupported(): boolean {
  return !!getSpeechRecognitionCtor();
}

/** True if this browser can play back audio (basically always). */
export function ttsSupported(): boolean {
  return typeof window !== "undefined" && "Audio" in window;
}

/**
 * Listen once via the browser's speech recognizer; onResult receives the
 * final transcript. The recognizer auto-stops itself once it detects the
 * end of speech (its own built-in silence/VAD detection — nothing custom
 * needed here), or stop() can be called early (e.g. a manual button tap).
 * onEnd always fires exactly once, after the session is fully over —
 * whether it ended via a result, an error, or a manual stop — so callers
 * can rely on it to know the mic is no longer active.
 */
export function startListening(
  onResult: (text: string) => void,
  onEnd: () => void,
  onError?: (msg: string) => void,
  lang = "en-US"
): () => void {
  const SR = getSpeechRecognitionCtor();
  if (!SR) {
    onError?.("Voice input isn't supported in this browser — try Chrome or Edge.");
    onEnd();
    return () => {};
  }

  const rec = new SR();
  rec.lang = lang;
  rec.interimResults = true;  // Enable interim results for better UX
  rec.maxAlternatives = 3;  // Allow up to 3 alternatives for better accuracy

  rec.onresult = (e: any) => {
    // Only process results if we have something new
    if (!e.results || e.results.length === 0) {
      return;
    }

    // Get the LATEST result only (most recent speech capture)
    const latestResultIndex = e.results.length - 1;
    const latestResult = e.results[latestResultIndex];
    
    // Only report back when we have a FINAL result (user finished speaking)
    if (!latestResult.isFinal) {
      // Interim result — still recording, don't report yet
      console.log("[Voice Input] Interim:", { 
        text: latestResult[0]?.transcript || "", 
        isFinal: false 
      });
      return;
    }

    // Find the best alternative by confidence
    let bestText = "";
    let bestConfidence = 0;

    for (let altIdx = 0; altIdx < latestResult.length; altIdx++) {
      const alt = latestResult[altIdx];
      const confidence = alt.confidence || 0;
      
      if (confidence > bestConfidence) {
        bestText = alt.transcript;
        bestConfidence = confidence;
      }
    }

    if (bestText) {
      console.log("[Voice Input] Captured (FINAL):", { text: bestText, confidence: bestConfidence });
      onResult(bestText);
    } else {
      console.warn("[Voice Input] No text in final result");
      onError?.("Didn't catch that — try again.");
    }
  };
  rec.onerror = (e: any) => {
    const code = e?.error;
    console.error("[Voice Input] Error:", code);
    if (code === "aborted") {
      // Fires on a manual stop() call — not a real failure, no message.
    } else if (code === "no-speech") {
      onError?.("Didn't catch anything — try again.");
    } else if (code === "not-allowed" || code === "service-not-allowed") {
      onError?.("Microphone access was blocked — check browser permissions.");
    } else {
      onError?.(`Voice recognition error (${code}) — try again.`);
    }
  };
  // onend always fires last (after onresult/onerror, or on its own if
  // neither fired) — the single place we signal "session over".
  rec.onend = () => {
    console.log("[Voice Input] Session ended");
    onEnd();
  };

  try {
    console.log("[Voice Input] Starting speech recognition...", { lang });
    rec.start();
  } catch (err) {
    console.error("[Voice Input] Failed to start:", err);
    onError?.("Couldn't start the microphone. Check permissions.");
    onEnd();
    return () => {};
  }

  return () => {
    try {
      rec.stop();
    } catch {
      /* already stopped */
    }
  };
}

let currentAudio: HTMLAudioElement | null = null;
let currentUrl: string | null = null;

/** Fetch server-side TTS for `text` and play it. onStart/onEnd/onError track state. */
export async function speak(
  token: string,
  text: string,
  onStart?: () => void,
  onEnd?: () => void,
  onError?: (msg: string) => void
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
    audio.onerror = (e: any) => {
      const errorMsg = e?.target?.error?.message || "Failed to play audio";
      onError?.("Couldn't play voice reply — " + errorMsg);
      onEnd?.();
    };
    await audio.play();
  } catch (err: any) {
    const errorMsg = err?.message || "Failed to generate voice reply";
    onError?.(errorMsg);
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
