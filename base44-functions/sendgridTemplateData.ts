/**
 * sendgridTemplateData — Shared SendGrid dynamic_template_data builders for boarding flows.
 *
 * Reference copy for Base44 deploy parity with netlify/functions/sendgrid-integration.js.
 * All boarding email functions MUST construct payloads through this module.
 */

import { firstOptionalEnv, optionalEnv, requiredUrlEnv } from './shared/config.ts';
import { ENV_ALIASES } from './shared/platformSecrets.ts';

export const BCC_EMAIL = 'support@thispagedoesnotexist12345.com';
export const CANONICAL_FIRST_TIME_PATH = '/OnboardingPassport';
export const CANONICAL_SECONDARY_PATH = '/ResumeFitCheck';
export const SEATS_RESERVED = 'F5-04';

/** Canonical fallback template IDs — keep aligned with netlify/functions/sendgrid-templates.js */
export const TEMPLATE_FALLBACKS = {
  alphaflightannouncement_v1: 'd-79b354192f4740e0a9c6a90ceea61bd2',
  boarding_confirmation_v1: 'd-678824bc506c432dae9eadab36c07904',
  boarding_pass_free_v1: 'd-91ca65ce16634f299a46af4f0645d540',
  boarding_pass_paid_v1: 'd-9290e951724f4b028d94945d4f06b69f',
  boarding_instructions_free_v1: 'd-747dac53dd2c4b47b33400376aad1672',
  boarding_instructions_paid_v1: 'd-d8ec12e940944c5596af1fa740cf7f07',
  vip_boarding_pass_v1: 'd-1e5c7552460444028e37c0f935a9e32f',
  vip_boarding_instructions_v1: 'd-54a2336a46134073b589ec5f698c11f3',
} as const;

export type TemplateKey = keyof typeof TEMPLATE_FALLBACKS;

const TEMPLATE_ENV: Record<TemplateKey, string> = {
  alphaflightannouncement_v1: 'SENDGRID_TEMPLATE_ALPHA_FLIGHT_ANNOUNCEMENT',
  boarding_confirmation_v1: 'SENDGRID_TEMPLATE_BOARDING_CONFIRMATION',
  boarding_pass_free_v1: 'SENDGRID_TEMPLATE_BOARDING_PASS_FREE',
  boarding_pass_paid_v1: 'SENDGRID_TEMPLATE_BOARDING_PASS_PAID',
  boarding_instructions_free_v1: 'SENDGRID_TEMPLATE_BOARDING_INSTRUCTIONS_FREE',
  boarding_instructions_paid_v1: 'SENDGRID_TEMPLATE_BOARDING_INSTRUCTIONS_PAID',
  vip_boarding_pass_v1: 'SENDGRID_TEMPLATE_VIP_BOARDING_PASS',
  vip_boarding_instructions_v1: 'SENDGRID_TEMPLATE_VIP_BOARDING_INSTRUCTIONS',
};

export interface SeatRecord {
  id?: string;
  seat_id?: string;
  tuj_code?: string;
  record_id?: string;
  seat_record_id?: string;
  user_email?: string;
  passenger_email?: string;
  email?: string;
  first_name?: string;
  last_name?: string;
  passenger_first_name?: string;
  passenger_last_name?: string;
  name?: string;
  boarding_type?: string;
  boardingtype?: string;
  cabin_class?: string;
  cabin_tier?: string;
  cabin?: string;
  passenger_cabin_class?: string;
  cabin_type?: string;
  flight_code?: string;
  flightcode?: string;
  flight_id?: string;
  flight_label?: string;
  flight_number?: string;
  departure_date?: string;
  scheduled_departure_date?: string;
  seats_available?: number | string;
  remaining_seats?: number | string;
  available_seats?: number | string;
  passport_url?: string;
  first_task_url?: string;
  secondary_url?: string;
  unsubscribe_url?: string;
  boarding_confirmation_sent_at?: string;
  boardingconfirmationsentat?: string;
  boarding_confirmation_dispatch_started_at?: string;
  boardingconfirmationdispatchstartedat?: string;
  [key: string]: unknown;
}

export interface BoardingDynamicData {
  first_name: string;
  last_name: string;
  user_email: string;
  seat_id: string;
  tuj_code: string;
  flight_code: string;
  flightcode: string;
  flight_id: string;
  cabin_class: string;
  cabin_tier: string;
  departure_date: string;
  seats_available: number | string;
  passport_url: string;
  first_task_url: string;
  secondary_url: string;
  unsubscribe_url: string;
  platform_url: string;
  boarding_type: string;
  boardingtype: string;
  seats_reserved: string;
  newsletter_brand?: string;
  newsletter_promo?: string;
}

export type BoardingPath = 'vip' | 'paid' | 'free' | 'alpha_announcement';

function mainSiteUrl(): string {
  return requiredUrlEnv('APP_BASE_URL');
}

function platformTechUrl(): string {
  return optionalEnv('PLATFORM_TECH_URL') || 'https://www.thispagedoesnotexist12345.tech';
}

export function buildBoardingTaskUrls(
  seat: SeatRecord,
  canonicalSeatId: string,
  tujCode: string,
  flightCode: string,
): { first_task_url: string; secondary_url: string } {
  const flightCodeParam = flightCode ? `&flight_code=${encodeURIComponent(flightCode)}` : '';
  const query = `seat_id=${encodeURIComponent(canonicalSeatId)}&tuj_code=${encodeURIComponent(tujCode)}${flightCodeParam}`;
  const techBase = platformTechUrl();
  return {
    first_task_url: seat.first_task_url
      ? String(seat.first_task_url)
      : `${techBase}${CANONICAL_FIRST_TIME_PATH}?${query}`,
    secondary_url: seat.secondary_url
      ? String(seat.secondary_url)
      : `${techBase}${CANONICAL_SECONDARY_PATH}?${query}`,
  };
}

function canonicalFlightId(): string {
  return firstOptionalEnv(...ENV_ALIASES.activeFlightCode) || 'FL-CG-001';
}

export function resolveTemplateId(key: TemplateKey): string {
  const envName = TEMPLATE_ENV[key];
  return firstOptionalEnv(envName) || TEMPLATE_FALLBACKS[key];
}

export function resolveSeatId(seat: SeatRecord): string {
  return String(seat.id || seat.seat_id || seat.tuj_code || '').trim();
}

export function resolveTujCode(seat: SeatRecord, seatId: string): string {
  return String(seat.tuj_code || seat.seat_id || seatId || '').trim();
}

export function resolveRecipient(seat: SeatRecord): string {
  return String(seat.user_email || seat.passenger_email || seat.email || '').trim();
}

export function resolveFirstName(seat: SeatRecord): string {
  if (seat.first_name || seat.passenger_first_name) {
    return String(seat.first_name || seat.passenger_first_name).trim();
  }
  const name = String(seat.name || '').trim();
  return name ? name.split(/\s+/)[0] : '';
}

export function resolveLastName(seat: SeatRecord): string {
  if (seat.last_name || seat.passenger_last_name) {
    return String(seat.last_name || seat.passenger_last_name).trim();
  }
  const name = String(seat.name || '').trim();
  const parts = name.split(/\s+/).filter(Boolean);
  return parts.length > 1 ? parts.slice(1).join(' ') : '';
}

export function resolveBoardingType(seat: SeatRecord): string {
  return String(seat.boarding_type || seat.boardingtype || 'first_class').trim().toLowerCase();
}

export function isVipBoardingType(boardingType: string): boolean {
  return boardingType === 'vip' || boardingType === 'bracket.barbie';
}

function resolveFlightCode(...values: unknown[]): string {
  for (const value of values) {
    const rawValue = String(value ?? '').trim();
    if (!rawValue) continue;
    if (/^FL(?:[\s-]?VIP)?[\s-]?(?:051126|CG[-_\s]?00[01])$/i.test(rawValue)) {
      return canonicalFlightId();
    }
    return rawValue;
  }
  return canonicalFlightId();
}

export function resolveFlightCodeForSeat(seat: SeatRecord): string {
  return resolveFlightCode(
    seat.flight_code,
    seat.flightcode,
    seat.flight_id,
    seat.flight_label,
    seat.flight_number,
  );
}

export function resolvePassportUrl(seat: SeatRecord, canonicalSeatId: string, tujCode: string): string {
  if (seat.passport_url) return String(seat.passport_url);
  const base = mainSiteUrl();
  return `${base}/?seat_id=${encodeURIComponent(canonicalSeatId)}&tuj_code=${encodeURIComponent(tujCode)}`;
}

export function resolveCabinTier(seat: SeatRecord, isVipBoarding: boolean): string {
  const raw = String(
    seat.cabin_tier || seat.cabin_class || seat.cabin || seat.boarding_type || '',
  ).trim().toLowerCase();
  if (raw === 'vip' || raw === 'first' || raw === 'first_class' || raw === 'paid') return 'first';
  if (raw === 'sponsored') return 'sponsored';
  if (isVipBoarding) return 'first';
  return 'economy';
}

export function resolveCabinClass(seat: SeatRecord, isVipBoarding: boolean): string {
  const rawValue = String(
    seat.cabin_class || seat.cabin || seat.passenger_cabin_class || seat.cabin_type || seat.boarding_type || '',
  ).trim().toLowerCase();
  if (rawValue === 'first' || rawValue === 'first_class' || rawValue === 'paid' || rawValue === 'vip') {
    return 'First';
  }
  if (rawValue === 'sponsored') return 'Sponsored';
  if (rawValue === 'economy' || rawValue === 'free' || rawValue === 'standard' || rawValue === 'alpha') {
    return 'Economy';
  }
  return isVipBoarding ? 'First' : 'Economy';
}

function resolveDepartureDate(seat: SeatRecord, isVipBoarding: boolean): string {
  const fallback = optionalEnv('ACTIVE_FLIGHT_DEPARTURE_DATE');
  return String(
    seat.departure_date || seat.scheduled_departure_date || fallback || '',
  ).trim();
}

function resolveSeatsAvailable(seat: SeatRecord): number | string {
  const value = seat.seats_available ?? seat.remaining_seats ?? seat.available_seats ?? 1;
  return typeof value === 'number' ? value : String(value);
}

/**
 * Determines which boarding email path to use.
 * Base44 canonical path: boarding_pass + boarding_instructions (free or paid by cabin).
 * Netlify sendgrid-integration also supports alpha_announcement for legacy alpha cohorts.
 */
export function resolveBoardingPath(seat: SeatRecord): BoardingPath {
  const boardingType = resolveBoardingType(seat);
  if (isVipBoardingType(boardingType)) return 'vip';

  const cabinTier = resolveCabinTier(seat, false);
  if (cabinTier === 'first') return 'paid';
  if (boardingType === 'alpha' || boardingType === 'first_class') return 'alpha_announcement';
  return 'free';
}

export function boardingTemplateSequence(path: BoardingPath): { label: string; key: TemplateKey }[] {
  switch (path) {
    case 'vip':
      return [
        { label: 'vip_boarding_pass_v1', key: 'vip_boarding_pass_v1' },
        { label: 'vip_boarding_instructions_v1', key: 'vip_boarding_instructions_v1' },
      ];
    case 'paid':
      return [
        { label: 'boarding_pass_paid_v1', key: 'boarding_pass_paid_v1' },
        { label: 'boarding_instructions_paid_v1', key: 'boarding_instructions_paid_v1' },
      ];
    case 'alpha_announcement':
      return [
        { label: 'alphaflightannouncement_v1', key: 'alphaflightannouncement_v1' },
        { label: 'boarding_confirmation_v1', key: 'boarding_confirmation_v1' },
      ];
    case 'free':
    default:
      return [
        { label: 'boarding_pass_free_v1', key: 'boarding_pass_free_v1' },
        { label: 'boarding_instructions_free_v1', key: 'boarding_instructions_free_v1' },
      ];
  }
}

export function buildBoardingDynamicData(seat: SeatRecord, path?: BoardingPath): BoardingDynamicData {
  const resolvedPath = path ?? resolveBoardingPath(seat);
  const isVipBoarding = resolvedPath === 'vip';
  const seatId = resolveSeatId(seat);
  const tujCode = resolveTujCode(seat, seatId);
  const canonicalSeatId = tujCode || seatId;
  const flightCode = resolveFlightCodeForSeat(seat);
  const base = mainSiteUrl();
  const passportUrl = resolvePassportUrl(seat, canonicalSeatId, tujCode);
  const taskUrls = buildBoardingTaskUrls(seat, canonicalSeatId, tujCode, flightCode);
  const unsubscribeUrl = seat.unsubscribe_url
    || optionalEnv('SENDGRID_UNSUBSCRIBE_URL')
    || `${base}/unsubscribe`;

  const data: BoardingDynamicData = {
    first_name: resolveFirstName(seat),
    last_name: resolveLastName(seat),
    user_email: resolveRecipient(seat),
    seat_id: seatId,
    tuj_code: tujCode,
    flight_code: flightCode,
    flightcode: flightCode,
    flight_id: flightCode,
    cabin_class: resolveCabinClass(seat, isVipBoarding),
    cabin_tier: resolveCabinTier(seat, isVipBoarding),
    departure_date: resolveDepartureDate(seat, isVipBoarding),
    seats_available: resolveSeatsAvailable(seat),
    passport_url: passportUrl,
    first_task_url: taskUrls.first_task_url,
    secondary_url: taskUrls.secondary_url,
    unsubscribe_url: unsubscribeUrl,
    platform_url: base,
    boarding_type: isVipBoarding ? 'vip' : resolvedPath === 'alpha_announcement' ? 'alpha' : 'standard',
    boardingtype: isVipBoarding ? 'vip' : resolvedPath === 'alpha_announcement' ? 'alpha' : 'standard',
    seats_reserved: SEATS_RESERVED,
  };

  if (isVipBoarding) {
    data.newsletter_brand = 'VIP cohort';
    data.newsletter_promo = 'Mission Control promo';
  }

  return data;
}

/** Fail-closed pre-send validation (SENDGRID-CG-001). */
export function validateBoardingPayload(dynamicData: BoardingDynamicData, label: string): string[] {
  const errors: string[] = [];
  const requiredHttpsFields: (keyof BoardingDynamicData)[] = ['passport_url', 'first_task_url', 'secondary_url'];

  for (const field of requiredHttpsFields) {
    const val = dynamicData[field];
    if (!val || typeof val !== 'string' || val.trim() === '') {
      errors.push(`${label}: required field '${field}' is absent or blank`);
    } else if (!val.startsWith('https://')) {
      errors.push(`${label}: required field '${field}' is not HTTPS — got: ${String(val).slice(0, 60)}`);
    }
  }

  if (!dynamicData.cabin_tier || typeof dynamicData.cabin_tier !== 'string' || dynamicData.cabin_tier.trim() === '') {
    errors.push(`${label}: required field 'cabin_tier' is absent or blank`);
  }

  return errors;
}

export function parseIso(value: string | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function dispatchLeaseMs(): number {
  const raw = optionalEnv('BOARDING_CONFIRMATION_DISPATCH_LEASE_MS');
  const parsed = raw ? Number.parseInt(raw, 10) : 15 * 60 * 1000;
  return Number.isFinite(parsed) && parsed >= 60_000 ? parsed : 15 * 60 * 1000;
}

export function isDispatchLeaseActive(dispatchStartedAt: string | undefined): boolean {
  if (!dispatchStartedAt) return false;
  const startedMs = parseIso(dispatchStartedAt);
  if (startedMs === null) return false;
  return Date.now() - startedMs < dispatchLeaseMs();
}
