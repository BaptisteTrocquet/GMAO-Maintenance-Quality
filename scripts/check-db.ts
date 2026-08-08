import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const rows = await prisma.$queryRaw<Array<{ ok: number }>>`SELECT 1 AS ok`;

  if (rows[0]?.ok !== 1) {
    throw new Error("Database readiness check returned an unexpected result");
  }

  console.log("Database integration check passed");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
