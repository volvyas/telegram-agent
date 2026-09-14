import type { MiddlewareFn } from "grammy";

export const UNAUTHORIZED_MESSAGE = "Unauthorized.";

export class AuthGuard {
  readonly #allowedUserIds: ReadonlySet<number>;

  public constructor(allowedUserIds: ReadonlySet<number>) {
    this.#allowedUserIds = new Set(allowedUserIds);
  }

  public middleware(): MiddlewareFn {
    return async (context, next) => {
      const userId = context.from?.id;
      if (userId !== undefined && this.#allowedUserIds.has(userId)) {
        await next();
        return;
      }

      if (context.callbackQuery !== undefined) {
        await context.answerCallbackQuery({
          text: UNAUTHORIZED_MESSAGE,
          show_alert: true,
        });
      } else if (context.chat !== undefined) {
        await context.reply(UNAUTHORIZED_MESSAGE);
      }
    };
  }
}
