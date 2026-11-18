import { PrismaClient, Prisma } from '@prisma/client';
export const db = new PrismaClient();

export async function lockConnection(tx: Prisma.TransactionClient, id: string) {
  await tx.$queryRaw`SELECT id FROM connections WHERE id = ${id} FOR UPDATE`;
  return tx.connection.findUnique({where:{id}});
}
