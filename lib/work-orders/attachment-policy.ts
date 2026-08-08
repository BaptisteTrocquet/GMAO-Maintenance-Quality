export const MAX_WORK_ORDER_PHOTO_BYTES = 10 * 1024 * 1024;

export const WORK_ORDER_PHOTO_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

export type WorkOrderPhotoMimeType = (typeof WORK_ORDER_PHOTO_MIME_TYPES)[number];

export function isWorkOrderPhotoMimeType(value: string): value is WorkOrderPhotoMimeType {
  return (WORK_ORDER_PHOTO_MIME_TYPES as readonly string[]).includes(value.toLowerCase());
}

export function detectWorkOrderPhotoMimeType(data: Uint8Array): WorkOrderPhotoMimeType | null {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return "image/jpeg";
  }

  if (
    data.length >= 8 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47 &&
    data[4] === 0x0d &&
    data[5] === 0x0a &&
    data[6] === 0x1a &&
    data[7] === 0x0a
  ) {
    return "image/png";
  }

  if (
    data.length >= 12 &&
    data[0] === 0x52 &&
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    data[3] === 0x46 &&
    data[8] === 0x57 &&
    data[9] === 0x45 &&
    data[10] === 0x42 &&
    data[11] === 0x50
  ) {
    return "image/webp";
  }

  return null;
}

export function workOrderAttachmentStoragePrefix(input: {
  organizationId: string;
  siteId: string;
  workOrderId: string;
}) {
  return `work-orders/${input.organizationId}/${input.siteId}/${input.workOrderId}`;
}
