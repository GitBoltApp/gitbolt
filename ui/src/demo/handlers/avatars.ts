import type { HandlerTable } from '../transport';
import { avatarPayload } from '../avatar';

export const avatarHandlers: Pick<HandlerTable, 'avatar' | 'forgeAvatarImage'> = {
  avatar: async ({ email }) => avatarPayload(email.trim().toLowerCase()),
  forgeAvatarImage: async ({ url }) => avatarPayload(url),
};
