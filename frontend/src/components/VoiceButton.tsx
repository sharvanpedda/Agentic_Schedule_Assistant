import { useEffect, useRef, useState } from "react";
import { useAuth } from "../lib/auth";
import { SILENCE_TIMEOUT_MS, speechSupported, startListening } from "../lib/speech";

const SILENCE_TIMEOUT_S = Math.round(SILENCE_TIMEOUT_MS / 1000);

/**
 * Mic button. Tap to start recording; it auto-stops after a pause in
 * speech (or tap again to stop early), transcribes what was said, and
 * hands the text back via onText — what the caller does with it (drop it
 * in the composer for review, or send it straight away) is up to them.
 */
export default function VoiceButton({
  onText,
  onError,
  disabled,
}: {
  onText: (text: string) => void;
  /** Called with a human-readable message whenever a voice turn fails
   * (mic permission denied, no audio captured, or the STT request itself
   * failing — e.g. a bad/expired Sarvam key, quota, or network issue).
   * Previously these failures were swallowed silently: the button just
   * went back to idle with no indication anything went wrong, which is
   * indistinguishable from "nothing happened". Wire this up to show the
   * actual error so failures are diagnosable instead of invisible. */
  onError?: (msg: string) => void;
  disabled?: boolean;
}) {
  const { token } = useAuth();
  const [listening, setListening] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const stopRef = useRef<(() => void) | null>(null);

  useEffect(() => () => stopRef.current?.(), []);

  const supported = speechSupported();

  const toggle = () => {
    if (!token) return;
    if (listening) {
      // Manual stop tap — just ask the recorder to stop. The onEnd
      // callback below (fired by speech.ts's onstop handler) is the
      // single source of truth for clearing `listening`, so this works
      // identically whether the user taps stop or the recorder auto-stops
      // itself (silence timeout / hard cap) without any tap at all.
      stopRef.current?.();
      return;
    }
    setListening(true);
    stopRef.current = startListening(
      token,
      (text) => {
        setTranscribing(false);
        onText(text);
      },
      () => {
        // Recording has ended — whether via a manual tap, the 5s silence
        // timeout, or the 60s hard cap. Previously this only cleared
        // `transcribing`, so on an auto-stop `listening` was never reset
        // and the button stayed stuck showing "Listening" forever even
        // though the mic itself had already stopped. Now we always drop
        // out of `listening` here and move into `transcribing` while the
        // clip uploads for transcription.
        setListening(false);
        setTranscribing(true);
      },
      (msg) => {
        setListening(false);
        setTranscribing(false);
        onError?.(msg);
      }
    );
  };

  const busy = listening || transcribing;

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={disabled || !supported || transcribing}
      title={
        supported
          ? listening
            ? `Listening — stops after ${SILENCE_TIMEOUT_S}s of silence (tap to stop now)`
            : "Speak your query"
          : "Voice needs microphone access in this browser"
      }
      aria-label="Voice input"
      className={`relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full border transition-all ${
        busy
          ? "border-alert/70 bg-alert/15 text-alert"
          : "border-line bg-panel text-mist hover:border-signal/60 hover:text-signal"
      } disabled:cursor-not-allowed disabled:opacity-40`}
    >
      {listening && (
        <span className="absolute inset-0 rounded-full border border-alert/50 animate-pulseRing" />
      )}
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3Z" />
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M6 11a1 1 0 0 1 1 1 5 5 0 0 0 10 0 1 1 0 1 1 2 0 7 7 0 0 1-6 6.93V21a1 1 0 1 1-2 0v-2.07A7 7 0 0 1 5 12a1 1 0 0 1 1-1Z"
        />
      </svg>
    </button>
  );
}
