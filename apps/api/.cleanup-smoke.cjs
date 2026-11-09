const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const del = await p.documentFile.deleteMany({
    where: { visibility: 'EXTERNAL', name: { startsWith: 'SMOKE-' } },
  });
  console.log('deleted smoke rows:', del.count);
  const rest = await p.documentFile.count({ where: { name: { startsWith: 'SMOKE-' } } });
  console.log('remaining smoke rows:', rest);
  await p.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
