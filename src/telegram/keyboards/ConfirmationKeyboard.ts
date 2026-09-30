import { InlineKeyboard } from "grammy";

import type { Confirmation } from "../../storage/Storage.js";

export type ConfirmationDecision = "allow" | "deny";

export interface ConfirmationCallback {
  readonly confirmationId: string;
  readonly decision: ConfirmationDecision;
}

const PREFIX = "confirm:";
const PATTERN = /^confirm:(allow|deny):([A-Za-z0-9_-]{16,40})$/u;

/** Creates bounded callbacks that carry only a confirmation's opaque ID. */
export class ConfirmationKeyboard {
  public build(confirmation: Confirmation): InlineKeyboard {
    return new InlineKeyboard()
      .text("Allow once", this.callbackData(confirmation.id, "allow"))
      .text("Deny", this.callbackData(confirmation.id, "deny"));
  }

  public callbackData(id: string, decision: ConfirmationDecision): string {
    const callback = `${PREFIX}${decision}:${id}`;
    if (!PATTERN.test(callback) || callback.length > 64) {
      throw new Error("Confirmation callback is outside Telegram limits");
    }
    return callback;
  }

  public resolve(data: string | undefined): ConfirmationCallback | undefined {
    const match = data === undefined ? undefined : PATTERN.exec(data);
    if (match === undefined || match === null) return undefined;
    const decision = match[1];
    const confirmationId = match[2];
    if ((decision !== "allow" && decision !== "deny") || confirmationId === undefined) return undefined;
    return { confirmationId, decision };
  }
}
