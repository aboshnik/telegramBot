export async function findEmployee(prisma, { fullName, position, department }) {
  // SQLite не поддерживает case-insensitive equality, поэтому сравниваем через LOWER() в сыром запросе
  const norm = (s) => (s || "").trim();
  const nf = norm(fullName);
  const np = norm(position);
  const nd = norm(department);

  const rows = await prisma.$queryRaw`
    SELECT *
    FROM EmployeeRef
    WHERE active = 1
      AND lower(fullName) = lower(${nf})
      AND lower(position) = lower(${np})
      AND lower(department) = lower(${nd})
    LIMIT 1
  `;

  return rows?.[0] || null;
}

