import "./env";
import express from "express";
import cors from "cors";
import { prisma } from "./lib/db";

const app = express();
const PORT = Number(process.env.PORT) || 3002;

app.use(
  cors({
    origin: process.env.CORS_ORIGIN || true,
  })
);
app.use(express.json());

// Placeholder — routes (companies, wines, scan) get ported over from
// wines-be-node next, adapted to be company-scoped.
app.get("/api/companies", async (_req, res) => {
  const companies = await prisma.company.findMany();
  res.json({ companies });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`MVP API listening on port ${PORT}`);
});
