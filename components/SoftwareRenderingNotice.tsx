"use client";

import { useEffect, useState } from "react";
import { detectSoftwareRendering } from "@/lib/benchmark";
import { useI18n } from "@/lib/i18n";
import HudNotice from "./HudNotice";

// With hardware acceleration off (or the GPU blocklisted) WebGL runs on the
// CPU at a frame or two per second, and no quality setting fixes that. Say
// so, with the fix, instead of leaving the visitor with a frozen-looking page.
export default function SoftwareRenderingNotice() {
  const { t } = useI18n();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    setVisible(detectSoftwareRendering());
  }, []);

  if (!visible) return null;
  return <HudNotice message={t("gpu.software")} accent="#e2674a" onDismiss={() => setVisible(false)} />;
}
