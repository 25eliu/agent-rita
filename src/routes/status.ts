import { Hono } from "hono";

export const statusRouter = new Hono();

statusRouter.get("/status", (c) =>
  c.json({ status: "ok", timestamp: new Date().toISOString() }),
);
