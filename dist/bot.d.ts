import "dotenv/config";
import { Bot, Context, SessionFlavor } from "grammy";
import { UserSession } from "./session";
type BotContext = Context & SessionFlavor<UserSession>;
declare const bot: Bot<BotContext, import("grammy").Api<import("grammy").RawApi>>;
export { bot };
export type { BotContext };
//# sourceMappingURL=bot.d.ts.map