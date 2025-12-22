export async function findEmployee(prisma, { fullName, phoneNumber }) {
  const norm = (s) => (s || "").trim();
  const onlyDigits = (s) => String(s || "").replace(/\D/g, "");

  const nf = norm(fullName);
  const userDigits = onlyDigits(phoneNumber);

  // Ищем по точному совпадению ФИОПолностью
  const candidates = await prisma.lexemaCard.findMany({
    where: {
      fullName: nf,
    },
  });

  if (!candidates.length) return null;

  // Если передан телефон — сверяем цифры
  if (userDigits) {
    const byPhone = candidates.find((c) => {
      const dbDigits = onlyDigits(c.phone);
      if (!dbDigits) return false;

      const normalizeForCompare = (a, b) => {
        if (a.length === 11 && a.startsWith("7") && b.length === 10) {
          return [a.slice(1), b];
        }
        if (b.length === 11 && b.startsWith("7") && a.length === 10) {
          return [a, b.slice(1)];
        }
        return [a, b];
      };

      const [u, d] = normalizeForCompare(userDigits, dbDigits);
      return u === d;
    });

    return byPhone || null;
  }

  // Если телефона нет — берём первого кандидата по ФИО
  return candidates[0] || null;
}

