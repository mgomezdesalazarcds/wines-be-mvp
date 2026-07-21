import "./env";
import express, { ErrorRequestHandler } from "express";
import cors from "cors";
import { prisma } from "./lib/db";
import { asyncHandler } from "./lib/asyncHandler";
import winesRouter from "./routes/wines";
import scanRouter from "./routes/scan";

const app = express();
const PORT = Number(process.env.PORT) || 3002;

app.use(
  cors({
    origin: process.env.CORS_ORIGIN || true,
  })
);
app.use(express.json());

app.use("/api/wines", winesRouter);
app.use("/api/scan", scanRouter);

app.get(
  "/api/companies",
  asyncHandler(async (_req, res) => {
    const companies = await prisma.company.findMany();
    res.json({ companies });
  })
);

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
};
app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`MVP API listening on port ${PORT}`);
});
