import { prisma } from "./db.js";

async function main() {
  const employees = [
    {
      fullName: "Иванов Иван Иванович",
      position: "Инженер",
      department: "Отдел разработки",
      phoneNumber: "9001112233",
    },
    {
      fullName: "Петров Петр Петрович",
      position: "Менеджер",
      department: "Отдел продаж",
      phoneNumber: "9002223344",
    },
    {
      fullName: "Сидорова Анна Сергеевна",
      position: "HR",
      department: "Отдел кадров",
      phoneNumber: "9003334455",
    },
    {
      fullName: "Кузнецов Дмитрий Олегович",
      position: "Разработчик",
      department: "Отдел разработки",
      phoneNumber: "9004445566",
    },
    {
      fullName: "Алексеева Мария Ивановна",
      position: "Аналитик",
      department: "Отдел кадров",
      phoneNumber: "9005556677",
    },
  ];

  const departmentChannels = [
    { department: "Отдел разработки", channelId: "Отдел разработки" },
    { department: "Отдел продаж", channelId: "Отдел продаж" },
    { department: "Отдел кадров", channelId: "Отдел кадров" },
  ];

  for (const emp of employees) {
    await prisma.employeeRef.upsert({
      where: {
        fullName_position_department: {
          fullName: emp.fullName,
          position: emp.position,
          department: emp.department,
        },
      },
      update: {
        active: true,
        phoneNumber: emp.phoneNumber,
      },
      create: emp,
    });
  }

  for (const dc of departmentChannels) {
    await prisma.departmentChannel.upsert({
      where: { department: dc.department },
      update: { channelId: dc.channelId },
      create: dc,
    });
  }
}

main()
  .then(async () => {
    console.log("Seed completed");
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });

