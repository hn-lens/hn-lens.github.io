import { useEffect, useState } from 'react';
import { Square, Volume2 } from 'lucide-react';

// A read-aloud control built on the platform's Web Speech API: speaks the provided text, toggles to
// NOTE: do NOT advertise this as "fully local". `speechSynthesis` uses whatever voice the OS/browser
// picks, and on several platforms the default is a NETWORK voice — the text can leave the device via
// the platform, not via this app. We make no locality claim here rather than a false one.
// Stop while speaking, and cancels on unmount OR when the text changes (e.g. a regenerated
// summary). No backend, no download. Renders nothing when the browser has no speech
// synthesis or there is no text — so callers can drop it in unconditionally.
export default function ListenButton({ text, className }: { text: string; className?: string }) {
  const canSpeak = typeof window !== 'undefined' && 'speechSynthesis' in window;
  const [speaking, setSpeaking] = useState(false);

  // Stop narration on unmount.
  useEffect(() => {
    return () => {
      if (canSpeak) window.speechSynthesis.cancel();
    };
  }, [canSpeak]);
  // If the text changes while speaking (regenerate / new item), stop the stale narration.
  useEffect(() => {
    if (canSpeak && window.speechSynthesis.speaking) {
      window.speechSynthesis.cancel();
      setSpeaking(false);
    }
  }, [text, canSpeak]);

  if (!canSpeak || !text) return null;

  const toggle = () => {
    if (window.speechSynthesis.speaking) {
      window.speechSynthesis.cancel();
      setSpeaking(false);
      return;
    }
    const u = new SpeechSynthesisUtterance(text);
    u.onend = () => setSpeaking(false);
    u.onerror = () => setSpeaking(false);
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
    setSpeaking(true);
  };

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={speaking}
      className={
        className ??
        'inline-flex items-center gap-1.5 rounded-lg border border-edge px-2.5 py-1 text-xs text-muted hover:bg-surface-2 hover:text-fg'
      }
    >
      {speaking ? (
        <>
          <Square className="size-3.5" /> Stop
        </>
      ) : (
        <>
          <Volume2 className="size-3.5" /> Listen
        </>
      )}
    </button>
  );
}
