"use client";

import { useI18n } from "@/lib/i18n";
import { CloseIcon } from "./Icons";
import { WOOD } from "./TrunkRings";

/**
 * Small dismissible notice for the top-left notice stack (see app/page.tsx).
 * The whole card is the dismiss button.
 */
export default function HudNotice({
  message,
  accent,
  onDismiss,
}: {
  message: string;
  accent: string;
  onDismiss: () => void;
}) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      onClick={onDismiss}
      aria-label={t("a11y.close")}
      className="anim-rise-x pointer-events-auto flex max-w-[min(300px,calc(100vw-2rem))] items-start gap-2 rounded-xl border px-3 py-2 text-left shadow-lg backdrop-blur-sm transition hover:brightness-110 active:scale-[0.98]"
      style={{
        borderColor: WOOD.barkDark,
        background: "rgba(11,16,13,0.82)",
        color: WOOD.textDim,
      }}
    >
      <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: accent }} />
      <span className="flex-1 text-[11px] leading-snug" style={{ color: WOOD.text }}>
        {message}
      </span>
      <CloseIcon className="mt-0.5 h-3 w-3 shrink-0" />
    </button>
  );
}
