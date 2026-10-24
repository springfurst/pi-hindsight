/**
 * Custom message renderers used by retain feedback and recall nudges.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

export function registerMessageRenderers(pi: ExtensionAPI): void {
  pi.registerMessageRenderer("hindsight-recall-nudge", (_message, _options, theme) => {
    let text = theme.fg("accent", "💡 Hindsight");
    text += theme.fg("muted", " recall nudge sent");
    return new Text(text, 0, 0);
  });

  pi.registerMessageRenderer("hindsight-retain", (message, _options, theme) => {
    const banks: string[] = (message.details as any)?.banks ?? [];
    let text = theme.fg("accent", "💾 Hindsight");
    text += theme.fg("muted", " saved turn to memory");
    if (banks.length > 0) {
      text += theme.fg("dim", ` → ${banks.join(", ")}`);
    }
    return new Text(text, 0, 0);
  });

  pi.registerMessageRenderer("hindsight-retain-failed", (_message, _options, theme) => {
    let text = theme.fg("error", "💾 Hindsight");
    text += theme.fg("muted", " retain failed - use ");
    text += theme.fg("accent", "hindsight_retain");
    text += theme.fg("muted", " to save manually");
    return new Text(text, 0, 0);
  });
}
