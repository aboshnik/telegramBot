import { addHours } from "date-fns";
import { config } from "../config.js";
import { prismaMeta } from "../dbMeta.js";

const isActiveLink = (link) =>
  link.status === "ACTIVE" && link.expiresAt > new Date();

export async function getActiveLink(prisma, telegramId, channelId) {
  return prismaMeta.inviteLink.findFirst({
    where: {
      telegramId: BigInt(telegramId),
      status: "ACTIVE",
      expiresAt: { gt: new Date() },
      channelId: String(channelId),
    },
    orderBy: { createdAt: "desc" },
  });
}

export async function createInviteLink({
  telegram,
  prisma,
  telegramId,
  fullName,
  channelId,
  ttlHours = config.linkTtlHours,
}) {
  const expiresAt = addHours(new Date(), ttlHours);
  const expire_date = Math.floor(expiresAt.getTime() / 1000);

  const invite = await telegram.createChatInviteLink(channelId, {
    expire_date,
    name: `Invite for ${fullName}`.slice(0, 32),
    member_limit: 1,
  });

  const ttlSeconds = ttlHours * 3600;

  const record = await prismaMeta.inviteLink.create({
    data: {
      telegramId: BigInt(telegramId),
      url: invite.invite_link,
      inviteLinkId: invite.invite_link_id || null,
      channelId: String(channelId),
      expiresAt,
      ttlSeconds,
      status: "ACTIVE",
    },
  });

  return record;
}

export async function getOrCreateInviteLink({
  telegram,
  prisma,
  telegramId,
  fullName,
  channelId,
}) {
  const existing = await getActiveLink(prisma, telegramId, channelId);
  if (existing && isActiveLink(existing)) {
    return existing;
  }

  return createInviteLink({ telegram, prisma, telegramId, fullName, channelId });
}

export async function expireInviteLink(prisma, inviteLinkId) {
  return prismaMeta.inviteLink.updateMany({
    where: { inviteLinkId, status: "ACTIVE" },
    data: { status: "EXPIRED" },
  });
}

