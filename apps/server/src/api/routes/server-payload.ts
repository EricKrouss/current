import type { FastifyInstance } from 'fastify';
import type { CurrentConfig } from '@current/config';

function buildPanelAsset(app: FastifyInstance, attachmentId: string | undefined) {
  const attachment = attachmentId ? app.appContext.chat.getAttachment(attachmentId) : null;
  return attachment
    ? {
        attachmentId: attachment.id,
        url: `/api/v1/media/attachments/${attachment.id}`,
      }
    : {};
}

export function buildPublicAppearance(app: FastifyInstance, config: CurrentConfig) {
  return {
    background: buildPanelAsset(app, config.appearance.backgroundAttachmentId || undefined),
    panelColor: config.appearance.panelColor || '',
    ownMessageColor: config.appearance.ownMessageColor || '',
    otherMessageColor: config.appearance.otherMessageColor || '',
  };
}

export function buildPublicServerPayload(app: FastifyInstance) {
  const config = app.appContext.serverConfig.get();
  const configServer = config.server;
  const serverRecord = app.appContext.repos.servers.getPrimaryServer();
  const primary = app.appContext.setup.status();

  return {
    ...serverRecord,
    ...configServer,
    id: serverRecord?.id ?? primary.serverId,
    iconAttachmentId: serverRecord?.iconAttachmentId,
    bannerAttachmentId: serverRecord?.bannerAttachmentId,
    iconUrl: serverRecord?.iconUrl,
    bannerUrl: serverRecord?.bannerUrl,
    appearance: buildPublicAppearance(app, config),
  };
}
