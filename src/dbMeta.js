import { PrismaClient } from "@prisma/client-meta";

export const prismaMeta = new PrismaClient();

export async function disconnectMetaDb() {
  await prismaMeta.$disconnect();
}



