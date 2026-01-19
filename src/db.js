import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient();

// Кэш для определения правильного названия таблицы
let detectedTableName = null;
const TABLE_NAMES = [
  "Lexema_Кадры_ЛичнаяКарточка",    // Смешанное название (латинская L + кириллица) - текущий вариант
  "Lexema_Kadry_LichnayaKartochka", // Английское название
  "Лексема_Кадры_ЛичнаяКарточка",   // Полностью русское название
];

// Функция для автоматического определения правильного названия таблицы
// Поддерживает как русское, так и английское название таблицы
export async function detectTableName() {
  if (detectedTableName) {
    return detectedTableName;
  }

  // Проверяем текущую базу данных
  try {
    const dbInfo = await prisma.$queryRawUnsafe(`SELECT DB_NAME() AS CurrentDatabase`);
    const currentDb = dbInfo[0]?.CurrentDatabase;
    console.log(`📊 Текущая база данных: ${currentDb || 'не определена'}`);
    if (currentDb && currentDb.toLowerCase() !== 'lktest') {
      console.warn(`⚠ Внимание: ожидается база данных 'lktest', но используется '${currentDb}'. Проверьте DB_URL в .env файле.`);
    }
  } catch (dbErr) {
    console.warn(`⚠ Не удалось определить текущую базу данных:`, dbErr.message);
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
  
  // Если не нашли, пробуем через INFORMATION_SCHEMA с более широким поиском
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
  
  console.warn("⚠ Не удалось автоматически определить название таблицы. Используется значение из schema.prisma");
  detectedTableName = TABLE_NAMES[0]; // Fallback на английское
  return detectedTableName;
}

// Функция для преобразования результатов raw SQL в формат Prisma
function transformRow(row) {
  return {
    code: row.code || row.VCode,
    lastName: row.lastName || row.Фамилия || null,
    firstName: row.firstName || row.Имя || null,
    middleName: row.middleName || row.Отчество || null,
    tabNumber: row.tabNumber !== undefined ? row.tabNumber : (row.ТабельныйНомер !== undefined ? String(row.ТабельныйНомер) : null),
    terminationDate: row.terminationDate || row.ДатаУвольнения || null,
    phone: row.phone || row.Сотовый || null,
    telegramUsername: row.telegramUsername || row.ТелеграмЮзернейм || null,
    telegramId: row.telegramId !== undefined && row.telegramId !== null 
      ? (typeof row.telegramId === 'bigint' ? row.telegramId : BigInt(row.telegramId))
      : (row.ТелеграмID !== undefined && row.ТелеграмID !== null 
          ? (typeof row.ТелеграмID === 'bigint' ? row.ТелеграмID : BigInt(row.ТелеграмID))
          : null),
    blacklisted: row.blacklisted !== undefined 
      ? (row.blacklisted === 1 || row.blacklisted === true)
      : (row.ЧерныйСписок !== undefined 
          ? (row.ЧерныйСписок === 1 || row.ЧерныйСписок === true)
          : false),
  };
}

// Функция для построения WHERE условий из Prisma where объекта
// Использует безопасную конкатенацию для простых случаев
function buildWhereClause(where) {
  if (!where || Object.keys(where).length === 0) {
    return '';
  }

  const conditions = [];

  for (const [key, value] of Object.entries(where)) {
    const columnName = getColumnName(key);
    
    if (value === null) {
      conditions.push(`[${columnName}] IS NULL`);
    } else if (value === undefined) {
      continue;
    } else if (typeof value === 'object' && value !== null) {
      if (value.not !== undefined) {
        if (value.not === null) {
          conditions.push(`[${columnName}] IS NOT NULL`);
          // Логирование для отладки
          if (key === 'terminationDate') {
            process.stdout.write(`[DEBUG buildWhereClause] Обработка terminationDate: { not: null } -> [${columnName}] IS NOT NULL\n`);
          }
        } else if (typeof value.not === 'bigint') {
          conditions.push(`[${columnName}] <> ${value.not.toString()}`);
        } else if (typeof value.not === 'string') {
          conditions.push(`[${columnName}] <> N'${value.not.replace(/'/g, "''")}'`);
        } else {
          conditions.push(`[${columnName}] <> ${value.not}`);
        }
      } else if (value.startsWith !== undefined) {
        const searchValue = value.startsWith.replace(/'/g, "''");
        conditions.push(`[${columnName}] LIKE N'${searchValue}%'`);
      } else if (value.contains !== undefined) {
        const searchValue = value.contains.replace(/'/g, "''");
        conditions.push(`[${columnName}] LIKE N'%${searchValue}%'`);
      } else if (value.equals !== undefined) {
        if (typeof value.equals === 'bigint') {
          conditions.push(`[${columnName}] = ${value.equals.toString()}`);
        } else if (typeof value.equals === 'string') {
          conditions.push(`[${columnName}] = N'${value.equals.replace(/'/g, "''")}'`);
        } else {
          conditions.push(`[${columnName}] = ${value.equals}`);
        }
      }
    } else {
      if (typeof value === 'bigint') {
        conditions.push(`[${columnName}] = ${value.toString()}`);
      } else if (typeof value === 'string') {
        conditions.push(`[${columnName}] = N'${value.replace(/'/g, "''")}'`);
      } else if (value === null) {
        conditions.push(`[${columnName}] IS NULL`);
      } else {
        conditions.push(`[${columnName}] = ${value}`);
      }
    }
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  if (where.terminationDate) {
    process.stdout.write(`[DEBUG buildWhereClause] Итоговый WHERE: ${whereClause}\n`);
  }
  return whereClause;
}

// Маппинг названий полей Prisma на названия колонок в БД
function getColumnName(prismaField) {
  const mapping = {
    code: 'VCode',
    lastName: 'Фамилия',
    firstName: 'Имя',
    middleName: 'Отчество',
    tabNumber: 'ТабельныйНомер',
    terminationDate: 'ДатаУвольнения',
    phone: 'Сотовый',
    telegramUsername: 'ТелеграмЮзернейм',
    telegramId: 'ТелеграмID',
    blacklisted: 'ЧерныйСписок',
  };
  return mapping[prismaField] || prismaField;
}

// Обертка для автоматического определения и использования правильного названия таблицы
// Использует raw SQL запросы для обхода проблем Prisma с смешанными названиями таблиц
export const lexemaCard = {
  async findMany(options = {}) {
    await detectTableName();
    const tableName = detectedTableName;
    
    try {
      let sql = `SELECT 
        VCode as code,
        Фамилия as lastName,
        Имя as firstName,
        Отчество as middleName,
        ТабельныйНомер as tabNumber,
        ДатаУвольнения as terminationDate,
        Сотовый as phone,
        ТелеграмЮзернейм as telegramUsername,
        ТелеграмID as telegramId,
        CAST(ЧерныйСписок AS INT) as blacklisted
      FROM [${tableName}]`;
      
      // Добавляем WHERE условия
      if (options.where) {
        const whereClause = buildWhereClause(options.where);
        if (whereClause) {
          sql += ` ${whereClause}`;
        }
      }
      
      // Добавляем ORDER BY
      if (options.orderBy) {
        const orderByKey = Object.keys(options.orderBy)[0];
        const orderByDir = options.orderBy[orderByKey] === 'desc' ? 'DESC' : 'ASC';
        sql += ` ORDER BY [${getColumnName(orderByKey)}] ${orderByDir}`;
      }
      
      // Добавляем TOP (LIMIT)
      if (options.take) {
        sql = sql.replace('SELECT', `SELECT TOP ${options.take}`);
      }
      
      // Логируем SQL запрос для отладки
      if (options.where && options.where.terminationDate) {
        process.stdout.write(`[DEBUG] SQL запрос findMany: ${sql}\n`);
      }
      
      const results = await prisma.$queryRawUnsafe(sql);
      if (options.where && options.where.terminationDate) {
        process.stdout.write(`[DEBUG] Результатов найдено: ${results.length}\n`);
      }
      return results.map(transformRow);
    } catch (err) {
      console.error(`Ошибка при выполнении findMany:`, err);
      throw err;
    }
  },
  
  async findFirst(options = {}) {
    await detectTableName();
    const tableName = detectedTableName;
    
    try {
      let sql = `SELECT TOP 1
        VCode as code,
        Фамилия as lastName,
        Имя as firstName,
        Отчество as middleName,
        ТабельныйНомер as tabNumber,
        ДатаУвольнения as terminationDate,
        Сотовый as phone,
        ТелеграмЮзернейм as telegramUsername,
        ТелеграмID as telegramId,
        CAST(ЧерныйСписок AS INT) as blacklisted
      FROM [${tableName}]`;
      
      // Добавляем WHERE условия
      if (options.where) {
        const whereClause = buildWhereClause(options.where);
        if (whereClause) {
          sql += ` ${whereClause}`;
        }
      }
      
      // Добавляем ORDER BY если есть
      if (options.orderBy) {
        const orderByKey = Object.keys(options.orderBy)[0];
        const orderByDir = options.orderBy[orderByKey] === 'desc' ? 'DESC' : 'ASC';
        sql += ` ORDER BY [${getColumnName(orderByKey)}] ${orderByDir}`;
      }
      
      const results = await prisma.$queryRawUnsafe(sql);
      return results.length > 0 ? transformRow(results[0]) : null;
    } catch (err) {
      console.error(`Ошибка при выполнении findFirst:`, err);
      throw err;
    }
  },
  
  async findUnique(options = {}) {
    // findUnique работает как findFirst, но обычно используется с where: { code: ... }
    return this.findFirst(options);
  },
  
  async update(options = {}) {
    await detectTableName();
    const tableName = detectedTableName;
    
    if (!options.where || !options.data) {
      throw new Error('update requires where and data options');
    }
    
    try {
      const setParts = [];
      
      // Обрабатываем data объект
      for (const [key, value] of Object.entries(options.data)) {
        if (value === undefined) continue;
        
        const columnName = getColumnName(key);
        
        if (value === null) {
          setParts.push(`[${columnName}] = NULL`);
        } else if (typeof value === 'bigint') {
          setParts.push(`[${columnName}] = ${value.toString()}`);
        } else if (typeof value === 'string') {
          setParts.push(`[${columnName}] = N'${value.replace(/'/g, "''")}'`);
        } else if (typeof value === 'boolean') {
          setParts.push(`[${columnName}] = ${value ? 1 : 0}`);
        } else if (value instanceof Date) {
          setParts.push(`[${columnName}] = '${value.toISOString().slice(0, 19).replace('T', ' ')}'`);
        } else {
          setParts.push(`[${columnName}] = ${value}`);
        }
      }
      
      if (setParts.length === 0) {
        throw new Error('No fields to update');
      }
      
      const whereClause = buildWhereClause(options.where);
      if (!whereClause) {
        throw new Error('where clause is required for update');
      }
      
      const sql = `UPDATE [${tableName}] SET ${setParts.join(', ')} ${whereClause}`;
      await prisma.$executeRawUnsafe(sql);
      
      // Возвращаем обновленную запись
      return this.findFirst({ where: options.where });
    } catch (err) {
      console.error(`Ошибка при выполнении update:`, err);
      throw err;
    }
  },
  
  async create(options = {}) {
    await detectTableName();
    const tableName = detectedTableName;
    
    if (!options.data) {
      throw new Error('create requires data option');
    }
    
    try {
      const columns = [];
      const values = [];
      
      for (const [key, value] of Object.entries(options.data)) {
        if (value === undefined) continue;
        
        const columnName = getColumnName(key);
        columns.push(`[${columnName}]`);
        
        if (value === null) {
          values.push('NULL');
        } else if (typeof value === 'bigint') {
          values.push(value.toString());
        } else if (typeof value === 'string') {
          values.push(`N'${value.replace(/'/g, "''")}'`);
        } else if (typeof value === 'boolean') {
          values.push(value ? 1 : 0);
        } else if (value instanceof Date) {
          values.push(`'${value.toISOString().slice(0, 19).replace('T', ' ')}'`);
        } else {
          values.push(value);
        }
      }
      
      if (columns.length === 0) {
        throw new Error('No fields to insert');
      }
      
      const sql = `INSERT INTO [${tableName}] (${columns.join(', ')}) VALUES (${values.join(', ')})`;
      await prisma.$executeRawUnsafe(sql);
      
      // Если есть code в data, возвращаем созданную запись
      if (options.data.code) {
        return this.findUnique({ where: { code: options.data.code } });
      }
      
      return options.data;
    } catch (err) {
      console.error(`Ошибка при выполнении create:`, err);
      throw err;
    }
  },
  
  async delete(options = {}) {
    await detectTableName();
    const tableName = detectedTableName;
    
    if (!options.where) {
      throw new Error('delete requires where option');
    }
    
    try {
      const whereClause = buildWhereClause(options.where);
      if (!whereClause) {
        throw new Error('where clause is required for delete');
      }
      
      const sql = `DELETE FROM [${tableName}] ${whereClause}`;
      await prisma.$executeRawUnsafe(sql);
      
      return { count: 1 };
    } catch (err) {
      console.error(`Ошибка при выполнении delete:`, err);
      throw err;
    }
  },
  
  async deleteMany(options = {}) {
    await detectTableName();
    const tableName = detectedTableName;
    
    try {
      let whereClause = '';
      if (options.where) {
        whereClause = buildWhereClause(options.where);
        if (whereClause) {
          whereClause = ` ${whereClause}`;
        }
      }
      
      const sql = `DELETE FROM [${tableName}]${whereClause}`;
      const result = await prisma.$executeRawUnsafe(sql);
      
      // SQL Server не возвращает количество удаленных строк напрямую через executeRaw
      // Но мы можем вернуть объект с count
      return { count: result || 0 };
    } catch (err) {
      console.error(`Ошибка при выполнении deleteMany:`, err);
      throw err;
    }
  },
  
  async updateMany(options = {}) {
    await detectTableName();
    const tableName = detectedTableName;
    
    if (!options.where || !options.data) {
      throw new Error('updateMany requires where and data options');
    }
    
    try {
      const setParts = [];
      
      for (const [key, value] of Object.entries(options.data)) {
        if (value === undefined) continue;
        
        const columnName = getColumnName(key);
        
        if (value === null) {
          setParts.push(`[${columnName}] = NULL`);
        } else if (typeof value === 'bigint') {
          setParts.push(`[${columnName}] = ${value.toString()}`);
        } else if (typeof value === 'string') {
          setParts.push(`[${columnName}] = N'${value.replace(/'/g, "''")}'`);
        } else if (typeof value === 'boolean') {
          setParts.push(`[${columnName}] = ${value ? 1 : 0}`);
        } else if (value instanceof Date) {
          setParts.push(`[${columnName}] = '${value.toISOString().slice(0, 19).replace('T', ' ')}'`);
        } else {
          setParts.push(`[${columnName}] = ${value}`);
        }
      }
      
      if (setParts.length === 0) {
        throw new Error('No fields to update');
      }
      
      const whereClause = buildWhereClause(options.where);
      if (!whereClause) {
        throw new Error('where clause is required for updateMany');
      }
      
      const sql = `UPDATE [${tableName}] SET ${setParts.join(', ')} ${whereClause}`;
      const result = await prisma.$executeRawUnsafe(sql);
      
      return { count: result || 0 };
    } catch (err) {
      console.error(`Ошибка при выполнении updateMany:`, err);
      throw err;
    }
  },
  
  async count(options = {}) {
    await detectTableName();
    const tableName = detectedTableName;
    
    try {
      let sql = `SELECT COUNT(*) as count FROM [${tableName}]`;
      
      if (options.where) {
        const whereClause = buildWhereClause(options.where);
        if (whereClause) {
          sql += ` ${whereClause}`;
        }
      }
      
      const results = await prisma.$queryRawUnsafe(sql);
      return results[0]?.count || 0;
    } catch (err) {
      console.error(`Ошибка при выполнении count:`, err);
      throw err;
    }
  },
};

export async function disconnectDb() {
  await prisma.$disconnect();
}



