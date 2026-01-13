import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient();

// Кэш для определения правильного названия таблицы
let detectedTableName = null;
// Маппинг реальных названий колонок в БД (для поддержки альтернативных названий)
let detectedColumnMapping = {};

// Обязательные колонки для работы бота (с альтернативными названиями)
const REQUIRED_COLUMNS_MAP = {
  'VCode': ['VCode', 'Code', 'code', 'VCODE'],  // код сотрудника
  'Фамилия': ['Фамилия', 'LastName', 'lastName', 'last_name', 'ФАМИЛИЯ'],  // фамилия
  'Имя': ['Имя', 'FirstName', 'firstName', 'first_name', 'ИМЯ'],  // имя
  'Отчество': ['Отчество', 'MiddleName', 'middleName', 'middle_name', 'ОТЧЕСТВО'],  // отчество
  'Подразделение': ['Подразделение', 'DepartmentId', 'departmentId', 'department_id', 'ПОДРАЗДЕЛЕНИЕ'],  // ID подразделения
  'Должность': ['Должность', 'PositionId', 'positionId', 'position_id', 'ДОЛЖНОСТЬ'],  // ID должности
  'Сотовый': ['Сотовый', 'Phone', 'phone', 'СОТОВЫЙ'],  // телефон
  'ДатаУвольнения': ['ДатаУвольнения', 'TerminationDate', 'terminationDate', 'termination_date', 'Дата_Увольнения', 'ДАТАУВОЛЬНЕНИЯ'],  // дата увольнения
  'ТелеграмID': ['ТелеграмID', 'TelegramId', 'telegramId', 'telegram_id', 'Телеграм_ID', 'ТЕЛЕГРАМID'],  // Telegram ID (обязательно)
  'ТелеграмЮзернейм': ['ТелеграмЮзернейм', 'TelegramUsername', 'telegramUsername', 'telegram_username', 'Телеграм_Юзернейм', 'ТЕЛЕГРАМЮЗЕРНЕЙМ'],  // Telegram username (обязательно)
  'ЧерныйСписок': ['ЧерныйСписок', 'Blacklisted', 'blacklisted', 'black_listed', 'Черный_Список', 'ЧЕРНЫЙСПИСОК'],  // черный список (обязательно)
};

// Опциональные колонки (в данный момент нет)
const OPTIONAL_COLUMNS_MAP = {};

// Список обязательных колонок для логирования
const REQUIRED_COLUMNS = Object.keys(REQUIRED_COLUMNS_MAP);
const OPTIONAL_COLUMNS = Object.keys(OPTIONAL_COLUMNS_MAP);

/**
 * Проверяет, содержит ли набор колонок все обязательные колонки (с учетом альтернативных названий)
 */
function hasAllRequiredColumns(columnNames) {
  const columnNamesLower = new Set(Array.from(columnNames).map(name => name.toLowerCase()));
  
  for (const [requiredCol, alternatives] of Object.entries(REQUIRED_COLUMNS_MAP)) {
    const found = alternatives.some(alt => 
      columnNames.has(alt) || columnNamesLower.has(alt.toLowerCase())
    );
    if (!found) {
      return { hasAll: false, missing: requiredCol };
    }
  }
  
  return { hasAll: true, missing: null };
}

/**
 * Находит реальное название колонки в БД по альтернативным вариантам
 */
function findColumnName(columnNames, requiredCol) {
  const alternatives = REQUIRED_COLUMNS_MAP[requiredCol] || OPTIONAL_COLUMNS_MAP[requiredCol] || [requiredCol];
  const columnNamesLower = new Map(Array.from(columnNames).map(name => [name.toLowerCase(), name]));
  
  for (const alt of alternatives) {
    if (columnNames.has(alt)) {
      return alt;
    }
    const lowerAlt = alt.toLowerCase();
    if (columnNamesLower.has(lowerAlt)) {
      return columnNamesLower.get(lowerAlt);
    }
  }
  
  return null;
}

/**
 * Автоматически находит таблицу в БД по набору обязательных колонок
 * Сканирует все таблицы в базе данных и ищет первую, которая содержит все необходимые колонки
 */
export async function detectTableName() {
  if (detectedTableName) {
    return detectedTableName;
  }

  try {
    // Получаем информацию о текущей базе данных
    const dbInfo = await prisma.$queryRawUnsafe(`SELECT DB_NAME() AS CurrentDatabase`);
    const currentDb = dbInfo[0]?.CurrentDatabase;
    console.log(`📊 Текущая база данных: ${currentDb || 'не определена'}`);
    
    // Получаем список всех таблиц в текущей базе данных
    const tables = await prisma.$queryRawUnsafe(`
      SELECT TABLE_NAME 
      FROM INFORMATION_SCHEMA.TABLES 
      WHERE TABLE_TYPE = 'BASE TABLE'
      ORDER BY TABLE_NAME
    `);
    
    if (!tables || tables.length === 0) {
      throw new Error('В базе данных не найдено ни одной таблицы');
    }
    
    console.log(`🔍 Найдено таблиц в БД: ${tables.length}. Проверяю наличие обязательных колонок...`);
    
    // Проверяем каждую таблицу на наличие обязательных колонок
    for (const table of tables) {
      const tableName = table.TABLE_NAME;
      
      try {
        // Получаем список колонок для текущей таблицы
        const columns = await prisma.$queryRawUnsafe(`
          SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE
          FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_NAME = '${tableName.replace(/'/g, "''")}'
        `);
        
        if (!columns || columns.length === 0) {
          console.log(`  ⚠ Таблица [${tableName}]: колонки не найдены`);
          continue;
        }
        
        // Создаем Set для быстрого поиска колонок
        const columnNames = new Set(columns.map(col => col.COLUMN_NAME));
        
        // Логируем найденные колонки для отладки
        console.log(`\n  📋 Таблица [${tableName}]:`);
        console.log(`     Найдено колонок: ${columns.length}`);
        console.log(`     Колонки: ${Array.from(columnNames).join(', ')}`);
        
        // Проверяем наличие всех обязательных колонок (с учетом альтернативных названий)
        const checkResult = hasAllRequiredColumns(columnNames);
        
        if (checkResult.hasAll) {
          // Создаем маппинг реальных названий колонок для использования в SQL
          const columnMapping = {};
          
          // Маппинг обязательных колонок
          for (const requiredCol of REQUIRED_COLUMNS) {
            const realName = findColumnName(columnNames, requiredCol);
            if (realName) {
              columnMapping[requiredCol] = realName;
            }
          }
          
          // Маппинг опциональных колонок (если они есть)
          for (const optionalCol of OPTIONAL_COLUMNS) {
            const realName = findColumnName(columnNames, optionalCol);
            if (realName) {
              columnMapping[optionalCol] = realName;
            }
          }
          
          // Сохраняем маппинг для использования в SQL запросах
          detectedColumnMapping = columnMapping;
          
          // Проверяем наличие опциональных колонок для информативности
          const hasOptional = OPTIONAL_COLUMNS.filter(col => {
            const realName = findColumnName(columnNames, col);
            return realName !== null;
          });
          
          detectedTableName = tableName;
          console.log(`\n✓ Таблица найдена: [${tableName}]`);
          console.log(`  Обязательные колонки: ✓ (${REQUIRED_COLUMNS.length}/${REQUIRED_COLUMNS.length})`);
          console.log(`  Маппинг колонок:`, columnMapping);
          
          // Логируем опциональные колонки только если они есть
          if (OPTIONAL_COLUMNS.length > 0) {
            const hasOptional = OPTIONAL_COLUMNS.filter(col => {
              const realName = findColumnName(columnNames, col);
              return realName !== null;
            });
            console.log(`  Опциональные колонки: ${hasOptional.length}/${OPTIONAL_COLUMNS.length} (${hasOptional.join(', ') || 'отсутствуют'})`);
          }
          
          return tableName;
        } else {
          console.log(`  ❌ Не хватает обязательной колонки: ${checkResult.missing}`);
          console.log(`     Ожидаемые варианты: ${REQUIRED_COLUMNS_MAP[checkResult.missing]?.join(', ') || checkResult.missing}`);
        }
      } catch (err) {
        console.error(`  ❌ Ошибка при проверке таблицы [${tableName}]:`, err.message);
        continue;
      }
    }
    
    // Если не нашли подходящую таблицу
    console.error(`\n❌ Не найдено таблицы с обязательными колонками: ${REQUIRED_COLUMNS.join(', ')}`);
    throw new Error(
      `Не найдено таблицы с обязательными колонками: ${REQUIRED_COLUMNS.join(', ')}\n` +
      `Проверьте, что в базе данных есть таблица с этими колонками.`
    );
    
  } catch (err) {
    console.error('❌ Ошибка при поиске таблицы:', err.message);
    throw err;
  }
}

// Функция для преобразования результатов raw SQL в формат Prisma
function transformRow(row) {
  return {
    code: row.code || row.VCode,
    lastName: row.lastName || row.Фамилия || null,
    firstName: row.firstName || row.Имя || null,
    middleName: row.middleName || row.Отчество || null,
    departmentId: row.departmentId !== undefined ? row.departmentId : (row.Подразделение !== undefined ? row.Подразделение : null),
    positionId: row.positionId !== undefined ? row.positionId : (row.Должность !== undefined ? row.Должность : null),
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

// Безопасное экранирование имени таблицы для SQL Server
// Использует квадратные скобки для поддержки кириллицы и специальных символов
function escapeTableName(tableName) {
  if (!tableName) return '';
  // Заменяем закрывающие квадратные скобки на двойные для экранирования
  return `[${tableName.replace(/\]/g, ']]')}]`;
}

// Маппинг названий полей Prisma на названия колонок в БД
// Использует реальные названия колонок из обнаруженной таблицы
function getColumnName(prismaField) {
  const mapping = {
    code: 'VCode',
    lastName: 'Фамилия',
    firstName: 'Имя',
    middleName: 'Отчество',
    departmentId: 'Подразделение',
    positionId: 'Должность',
    terminationDate: 'ДатаУвольнения',
    phone: 'Сотовый',
    telegramUsername: 'ТелеграмЮзернейм',
    telegramId: 'ТелеграмID',
    blacklisted: 'ЧерныйСписок',
  };
  
  const expectedColName = mapping[prismaField] || prismaField;
  
  // Если есть маппинг реальных названий колонок, используем его
  if (detectedColumnMapping && detectedColumnMapping[expectedColName]) {
    return detectedColumnMapping[expectedColName];
  }
  
  return expectedColName;
}

// Формирует SELECT список с использованием реальных названий колонок
function buildSelectList() {
  const vCodeCol = getColumnName('code');
  const lastNameCol = getColumnName('lastName');
  const firstNameCol = getColumnName('firstName');
  const middleNameCol = getColumnName('middleName');
  const departmentIdCol = getColumnName('departmentId');
  const positionIdCol = getColumnName('positionId');
  const terminationDateCol = getColumnName('terminationDate');
  const phoneCol = getColumnName('phone');
  
  // Опциональные колонки (могут отсутствовать)
  const telegramUsernameCol = getColumnName('telegramUsername');
  const telegramIdCol = getColumnName('telegramId');
  const blacklistedCol = getColumnName('blacklisted');
  
  return `SELECT 
    [${vCodeCol}] as code,
    [${lastNameCol}] as lastName,
    [${firstNameCol}] as firstName,
    [${middleNameCol}] as middleName,
    [${departmentIdCol}] as departmentId,
    [${positionIdCol}] as positionId,
    [${terminationDateCol}] as terminationDate,
    [${phoneCol}] as phone,
    [${telegramUsernameCol}] as telegramUsername,
    [${telegramIdCol}] as telegramId,
    CAST([${blacklistedCol}] AS INT) as blacklisted`;
}

// Обертка для автоматического определения и использования правильного названия таблицы
// Использует raw SQL запросы для обхода проблем Prisma с смешанными названиями таблиц
export const lexemaCard = {
  async findMany(options = {}) {
    await detectTableName();
    const tableName = detectedTableName;
    
    try {
      let sql = `${buildSelectList()} FROM ${escapeTableName(tableName)}`;
      
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
      let sql = `${buildSelectList().replace('SELECT', 'SELECT TOP 1')} FROM ${escapeTableName(tableName)}`;
      
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
      
      const sql = `UPDATE ${escapeTableName(tableName)} SET ${setParts.join(', ')} ${whereClause}`;
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
      
      const sql = `INSERT INTO ${escapeTableName(tableName)} (${columns.join(', ')}) VALUES (${values.join(', ')})`;
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
      
      const sql = `DELETE FROM ${escapeTableName(tableName)} ${whereClause}`;
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
      
      const sql = `DELETE FROM ${escapeTableName(tableName)}${whereClause}`;
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
      let sql = `SELECT COUNT(*) as count FROM ${escapeTableName(tableName)}`;
      
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



