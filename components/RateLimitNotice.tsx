"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n";
import HudNotice from "./HudNotice";

// Shown when a stargazer refresh actually hit GitHub's rate limit (never for
// a plain "no data yet" first load). Dismiss is sticky across the 5-min poll
// cycle: it only reappears once `active` transitions false→true again, i.e.
// the underlying state really changed.
export default function RateLimitNotice({ active }: { active: boolean }) {
  const { t } = useI18n();
  const [dismissed, setDismissed] = useState(false);
  const wasActive = useRef(active);

  useEffect(() => {
    if (active && !wasActive.current) setDismissed(false);
    wasActive.current = active;
  }, [active]);

  if (!active || dismissed) return null;
  return <HudNotice message={t("rateLimit.notice")} accent="#e2b04a" onDismiss={() => setDismissed(true)} />;
}
