import "../src/env";
import { prisma } from "../src/lib/db";
import { hashPassword } from "../src/lib/auth";

async function main() {
  const slugArg = process.argv[2];
  const emailArg = process.argv[3];
  const passwordArg = process.argv[4];

  if (!slugArg || !emailArg || !passwordArg) {
    console.error("Usage: npm run create-user -- <company-slug> <email> <password>");
    process.exit(1);
  }

  const company = await prisma.company.findUnique({ where: { slug: slugArg } });
  if (!company) {
    console.error(`No company with slug "${slugArg}". Create it first (see prisma/seed.ts).`);
    process.exit(1);
  }

  const email = emailArg.trim().toLowerCase();
  const passwordHash = await hashPassword(passwordArg);

  const user = await prisma.user.upsert({
    where: { email },
    update: { passwordHash, companyId: company.id },
    create: { email, passwordHash, companyId: company.id },
  });

  console.log(`User ready: ${user.email} → company "${company.name}" (${company.slug})`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
