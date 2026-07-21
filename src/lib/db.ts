import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient();

/** Placeholder until real multi-tenant routing exists (subdomain/slug per
 * request, auth) — every request today is scoped to this one company.
 * Cached after the first lookup since it never changes within a process. */
let cachedCompanyId: string | null = null;

export async function getDefaultCompanyId(): Promise<string> {
  if (cachedCompanyId) return cachedCompanyId;
  const slug = process.env.DEFAULT_COMPANY_SLUG || "little-bros";
  const company = await prisma.company.findUniqueOrThrow({ where: { slug } });
  cachedCompanyId = company.id;
  return company.id;
}
