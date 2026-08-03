import "../src/env";
import { Role } from "@prisma/client";
import { prisma } from "../src/lib/db";
import { hashPassword } from "../src/lib/auth";

async function main() {
  const emailArg = process.argv[2];
  const passwordArg = process.argv[3];

  if (!emailArg || !passwordArg) {
    console.error("Usage: npm run create-super-admin -- <email> <password>");
    process.exit(1);
  }

  const email = emailArg.trim().toLowerCase();
  const passwordHash = await hashPassword(passwordArg);

  const user = await prisma.user.upsert({
    where: { email },
    update: { passwordHash, role: Role.SUPER_ADMIN, companyId: null },
    create: { email, passwordHash, role: Role.SUPER_ADMIN },
  });

  console.log(`Super admin ready: ${user.email}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
