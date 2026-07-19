/**
 * attachQrCode — Base44 Function
 *
 * Generates a branded QR code for a paid passenger's Mission Control URL
 * and attaches it to their Seat record as `qr_code_url`.
 *
 * Trigger: Called from Admin panel after a seat is opened with cabin_class = 'First'.
 * Can also be called manually to regenerate a QR code.
 *
 * Input:  { seat_id: string }   — e.g. "TUJ-CC2222"
 * Output: { ok: boolean, qr_code_url: string, seat_id: string }
 *
 * Dependencies:
 *   - npm:qrcode (Deno-compatible QR generation)
 *   - npm:imagescript (center logo compositing)
 *   - Base44 SDK: base44.asServiceRole.entities.Seat
 *   - Base44 SDK: base44.asServiceRole.integrations.Core.UploadFile
 *
 * Auth: Admin only (service role write)
 */

import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';
import { requiredUrlEnv } from './shared/config.ts';
import { resolveBoardingPath, type SeatRecord } from './sendgridTemplateData.ts';
// @ts-ignore — Deno npm: specifier has no bundled types
import QRCode from 'npm:qrcode@1.5.3';
// @ts-ignore
import { Image } from 'npm:imagescript@1.3.0';

const APP_BASE_URL = requiredUrlEnv('APP_BASE_URL');
const SEAT_ID_REGEX = /^TUJ-[A-Z2-9]{6}$/i;

// Center logo: the Happy Easter hand-lettered artwork (hosted on CDN)
// Pre-cropped circular version generated on Apr 5, 2026
const LOGO_URL =
  'https://files.manuscdn.com/user_upload_by_module/session_file/310519663170199212/InWMZofWoRfRSnhu.png';

const QR_OPTIONS = {
  errorCorrectionLevel: 'H' as const,
  type: 'image/png' as const,
  width: 600,
  margin: 3,
  color: {
    dark: '#1c1c30',
    light: '#ffffff',
  },
};

function normalizeSeatId(value: string): string {
  const trimmed = String(value || '').trim();
  if (SEAT_ID_REGEX.test(trimmed)) return trimmed.toUpperCase();
  return trimmed;
}

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const base64Data = dataUrl.split(',')[1];
  if (!base64Data) throw new Error('Invalid QR data URL');
  return Uint8Array.from(atob(base64Data), (c) => c.charCodeAt(0));
}

async function compositeCenterLogo(qrBytes: Uint8Array): Promise<Uint8Array> {
  const qrImage = await Image.decode(qrBytes);
  const logoRes = await fetch(LOGO_URL);
  if (!logoRes.ok) {
    throw new Error(`Failed to fetch center logo: HTTP ${logoRes.status}`);
  }

  const logoBytes = new Uint8Array(await logoRes.arrayBuffer());
  const logo = await Image.decode(logoBytes);

  const logoSize = Math.floor(qrImage.width * 0.22);
  const pad = Math.floor(logoSize * 0.12);
  const totalSize = logoSize + pad * 2;
  const x = Math.floor((qrImage.width - totalSize) / 2);
  const y = Math.floor((qrImage.height - totalSize) / 2);

  const whitePad = new Image(totalSize, totalSize);
  whitePad.fill(0xffffffff);
  qrImage.composite(whitePad, x, y);

  const resizedLogo = logo.resize(logoSize, logoSize);
  qrImage.composite(resizedLogo, x + pad, y + pad);

  return await qrImage.encode();
}

async function generateBrandedQrPng(url: string): Promise<Uint8Array> {
  const qrDataUrl: string = await QRCode.toDataURL(url, QR_OPTIONS);
  const qrBytes = dataUrlToBytes(qrDataUrl);
  return compositeCenterLogo(qrBytes);
}

Deno.serve(async (req) => {
  try {
    if (req.method !== 'POST') {
      return Response.json({ error: 'Method Not Allowed' }, { status: 405 });
    }

    const base44 = createClientFromRequest(req);

    const caller = await base44.auth.me();
    if (!caller || caller.role !== 'admin') {
      return Response.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = await req.json();
    const seatId = normalizeSeatId(body?.seat_id);

    if (!seatId || !SEAT_ID_REGEX.test(seatId)) {
      return Response.json({ error: 'Invalid or missing seat_id' }, { status: 400 });
    }

    const seats = await base44.asServiceRole.entities.Seat.filter({ seat_id: seatId });
    let seat = seats?.[0];

    if (!seat) {
      const byTuj = await base44.asServiceRole.entities.Seat.filter({ tuj_code: seatId });
      seat = byTuj?.[0];
    }

    if (!seat) {
      return Response.json({ error: `Seat not found: ${seatId}` }, { status: 404 });
    }

    if (resolveBoardingPath(seat as SeatRecord) !== 'paid') {
      return Response.json({
        ok: false,
        skipped: true,
        reason: 'Seat is not on the paid (First class) boarding path — QR code not generated',
        seat_id: seatId,
      });
    }

    const missionControlUrl = `${APP_BASE_URL}/?seat_id=${seatId}`;
    const pngBytes = await generateBrandedQrPng(missionControlUrl);
    const blob = new Blob([pngBytes], { type: 'image/png' });
    const file = new File([blob], `qr_${seatId}.png`, { type: 'image/png' });

    const uploadResult = await base44.asServiceRole.integrations.Core.UploadFile({ file });
    const qrCodeUrl: string = uploadResult.file_url;

    await base44.asServiceRole.entities.Seat.update(seat.id, {
      qr_code_url: qrCodeUrl,
    });

    console.log(`[attachQrCode] QR code attached for ${seatId}: ${qrCodeUrl}`);

    return Response.json({
      ok: true,
      seat_id: seatId,
      qr_code_url: qrCodeUrl,
      mission_control_url: missionControlUrl,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[attachQrCode] Error:', message);
    return Response.json({ error: message }, { status: 500 });
  }
});
