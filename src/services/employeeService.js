export async function findEmployee(prisma, { lastName, firstName, middleName, positionId, departmentId, phoneNumber }) {
  const norm = (s) => (s || "").trim();
  const onlyDigits = (s) => String(s || "").replace(/\D/g, "");

  // Формируем условия поиска
  const where = {};
  
  if (lastName) {
    where.lastName = { contains: norm(lastName) };
  }
  if (firstName) {
    where.firstName = { contains: norm(firstName) };
  }
  if (middleName) {
    where.middleName = { contains: norm(middleName) };
  }
  if (positionId !== null && positionId !== undefined) {
    where.positionId = parseInt(positionId);
  }
  if (departmentId !== null && departmentId !== undefined) {
    where.departmentId = parseInt(departmentId);
  }

  // Ищем кандидатов по ФИО, должности и подразделению
  let candidates = await prisma.lexemaCard.findMany({
    where,
  });

  if (!candidates.length) return null;

  // Фильтруем по точному совпадению ФИО (без учета регистра)
  const normLower = (s) => (s || "").trim().toLowerCase();
  const filtered = candidates.filter((c) => {
    const matchLastName = !lastName || normLower(c.lastName || "") === normLower(lastName);
    const matchFirstName = !firstName || normLower(c.firstName || "") === normLower(firstName);
    const matchMiddleName = !middleName || 
      (middleName === null && !c.middleName) ||
      (middleName !== null && normLower(c.middleName || "") === normLower(middleName));
    return matchLastName && matchFirstName && matchMiddleName;
  });

  if (!filtered.length) return null;

  // Если передан телефон — сверяем цифры
  if (phoneNumber) {
    const userDigits = onlyDigits(phoneNumber);
    const byPhone = filtered.find((c) => {
      if (!c.phone) return false;
      const dbDigits = onlyDigits(c.phone);

      // Нормализуем оба номера к единому формату: 10 цифр, начинающихся с 9
      const normalizeForCompare = (digits) => {
        // Если номер начинается с 7 (11 цифр): убираем первую 7
        if (digits.length === 11 && digits.startsWith("7")) {
          return digits.slice(1);
        }
        // Если номер начинается с 8 (11 цифр): убираем первую 8
        if (digits.length === 11 && digits.startsWith("8")) {
          return digits.slice(1);
        }
        // Если номер 10 цифр и начинается с 8: убираем первую 8, добавляем 9
        if (digits.length === 10 && digits.startsWith("8")) {
          return "9" + digits.slice(1);
        }
        // Если номер 9 цифр: добавляем 9 в начало
        if (digits.length === 9) {
          return "9" + digits;
        }
        // Если номер 10 цифр и начинается с 9: оставляем как есть
        if (digits.length === 10 && digits.startsWith("9")) {
          return digits;
        }
        // Возвращаем как есть
        return digits;
      };
      
      const userNorm = normalizeForCompare(userDigits);
      const dbNorm = normalizeForCompare(dbDigits);
      
      // Сравниваем нормализованные номера
      return userNorm === dbNorm;
    });

    return byPhone || null;
  }

  // Если телефона нет — берём первого кандидата
  return filtered[0] || null;
}

