import { activityRouter } from "./routers/activity";
import { externalRouter } from "./routers/external";
import { healthRouter } from "./routers/health";
import { listerRouter } from "./routers/lister";
import { itemsRouter } from "./routers/items";
import { mediaRouter } from "./routers/media";
import { orgRouter } from "./routers/org";
import { createTRPCRouter } from "./trpc";

export const appRouter = createTRPCRouter({
  health: healthRouter,
  org: orgRouter,
  items: itemsRouter,
  media: mediaRouter,
  activity: activityRouter,
  lister: listerRouter,
  external: externalRouter,
});

export type AppRouter = typeof appRouter;
