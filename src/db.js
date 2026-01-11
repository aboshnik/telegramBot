import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient();

// Кэш для определения правильного названия таблицы
let detectedTableName = null;
const TABLE_NAMES = [
  "Lexema_Kadry_LichnayaKartochka", // Английское название
  "Лексема_Кадры_ЛичнаяКарточка",   // Русское название
];

// Функция для автоматического определения правильного названия таблицы
// Поддерживает как русское, так и английское название таблицы
export async function detectTableName() {
  if (detectedTableName) {
    return detectedTableName;
  }

  for (const tableName of TABLE_NAMES) {
    try {
      // Используем правильный синтаксис SQL Server с квадратными скобками для кириллицы
      const result = await prisma.$queryRawUnsafe(
        `SELECT TOP 1 TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = '${tableName.replace(/'/g, "''")}'`
      );
      
      if (result && Array.isArray(result) && result.length > 0) {
        detectedTableName = tableName;
        console.log(`✓ Таблица автоматически определена: ${tableName}`);
        return tableName;
      }
    } catch (err) {
      // Игнорируем ошибки и пробуем следующий вариант
      continue;
    }
  }
  
  // Если не нашли, пробуем через Prisma модель (использует название из schema.prisma)
  try {
    await prisma.lexemaCard.findFirst({ take: 1 });
    // Если запрос прошел успешно, используем название из schema.prisma
    detectedTableName = TABLE_NAMES[0]; // По умолчанию английское
    console.log(`✓ Используется название таблицы из schema.prisma`);
    return detectedTableName;
  } catch (err) {
    if (err.code === 'P2021') {
      // Таблица не найдена с текущим названием, пробуем альтернативное
      console.log(`⚠ Таблица не найдена с текущим названием, пробуем альтернативное...`);
      // Попробуем определить через INFORMATION_SCHEMA с более широким поиском
      try {
        const allTables = await prisma.$queryRawUnsafe(
          `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME LIKE '%Lexema%' OR TABLE_NAME LIKE '%Лексема%' OR TABLE_NAME LIKE '%Kadry%' OR TABLE_NAME LIKE '%Кадры%'`
        );
        if (allTables && Array.isArray(allTables) && allTables.length > 0) {
          const foundName = allTables[0].TABLE_NAME;
          detectedTableName = foundName;
          console.log(`✓ Таблица найдена через поиск: ${foundName}`);
          return foundName;
        }
      } catch (searchErr) {
        console.error("Ошибка при поиске таблицы:", searchErr);
      }
    }
  }
  
  console.warn("⚠ Не удалось автоматически определить название таблицы. Используется значение из schema.prisma");
  detectedTableName = TABLE_NAMES[0]; // Fallback на английское
  return detectedTableName;
}

// Обертка для автоматического определения и использования правильного названия таблицы
export const lexemaCard = {
  async findMany(...args) {
    await detectTableName();
    try {
      return await prisma.lexemaCard.findMany(...args);
    } catch (err) {
      if (err.code === 'P2021' && detectedTableName !== TABLE_NAMES[0]) {
        // Если ошибка и мы определили другое название, нужно обновить schema.prisma
        console.error(`⚠ Ошибка: таблица называется "${detectedTableName}", но в schema.prisma указано другое название. Обновите @@map в schema.prisma и перегенерируйте клиент.`);
      }
      throw err;
    }
  },
  
  async findFirst(...args) {
    await detectTableName();
    try {
      return await prisma.lexemaCard.findFirst(...args);
    } catch (err) {
      if (err.code === 'P2021' && detectedTableName !== TABLE_NAMES[0]) {
        console.error(`⚠ Ошибка: таблица называется "${detectedTableName}", но в schema.prisma указано другое название. Обновите @@map в schema.prisma и перегенерируйте клиент.`);
      }
      throw err;
    }
  },
  
  async findUnique(...args) {
    await detectTableName();
    try {
      return await prisma.lexemaCard.findUnique(...args);
    } catch (err) {
      if (err.code === 'P2021' && detectedTableName !== TABLE_NAMES[0]) {
        console.error(`⚠ Ошибка: таблица называется "${detectedTableName}", но в schema.prisma указано другое название. Обновите @@map в schema.prisma и перегенерируйте клиент.`);
      }
      throw err;
    }
  },
  
  async update(...args) {
    await detectTableName();
    try {
      return await prisma.lexemaCard.update(...args);
    } catch (err) {
      if (err.code === 'P2021' && detectedTableName !== TABLE_NAMES[0]) {
        console.error(`⚠ Ошибка: таблица называется "${detectedTableName}", но в schema.prisma указано другое название. Обновите @@map в schema.prisma и перегенерируйте клиент.`);
      }
      throw err;
    }
  },
  
  async create(...args) {
    await detectTableName();
    try {
      return await prisma.lexemaCard.create(...args);
    } catch (err) {
      if (err.code === 'P2021' && detectedTableName !== TABLE_NAMES[0]) {
        console.error(`⚠ Ошибка: таблица называется "${detectedTableName}", но в schema.prisma указано другое название. Обновите @@map в schema.prisma и перегенерируйте клиент.`);
      }
      throw err;
    }
  },
  
  async delete(...args) {
    await detectTableName();
    try {
      return await prisma.lexemaCard.delete(...args);
    } catch (err) {
      if (err.code === 'P2021' && detectedTableName !== TABLE_NAMES[0]) {
        console.error(`⚠ Ошибка: таблица называется "${detectedTableName}", но в schema.prisma указано другое название. Обновите @@map в schema.prisma и перегенерируйте клиент.`);
      }
      throw err;
    }
  },
  
  async deleteMany(...args) {
    await detectTableName();
    try {
      return await prisma.lexemaCard.deleteMany(...args);
    } catch (err) {
      if (err.code === 'P2021' && detectedTableName !== TABLE_NAMES[0]) {
        console.error(`⚠ Ошибка: таблица называется "${detectedTableName}", но в schema.prisma указано другое название. Обновите @@map в schema.prisma и перегенерируйте клиент.`);
      }
      throw err;
    }
  },
  
  async updateMany(...args) {
    await detectTableName();
    try {
      return await prisma.lexemaCard.updateMany(...args);
    } catch (err) {
      if (err.code === 'P2021' && detectedTableName !== TABLE_NAMES[0]) {
        console.error(`⚠ Ошибка: таблица называется "${detectedTableName}", но в schema.prisma указано другое название. Обновите @@map в schema.prisma и перегенерируйте клиент.`);
      }
      throw err;
    }
  },
  
  async count(...args) {
    await detectTableName();
    try {
      return await prisma.lexemaCard.count(...args);
    } catch (err) {
      if (err.code === 'P2021' && detectedTableName !== TABLE_NAMES[0]) {
        console.error(`⚠ Ошибка: таблица называется "${detectedTableName}", но в schema.prisma указано другое название. Обновите @@map в schema.prisma и перегенерируйте клиент.`);
      }
      throw err;
    }
  },
};

export async function disconnectDb() {
  await prisma.$disconnect();
}



