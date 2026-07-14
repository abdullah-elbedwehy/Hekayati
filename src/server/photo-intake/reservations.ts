import { randomBytes, randomUUID } from "node:crypto";

export const DEFAULT_PHOTO_RESERVATION_TTL_MS = 15 * 60 * 1000;

export class PhotoReservationError extends Error {
  readonly statusCode = 404;
  readonly code = "PHOTO_RESERVATION_NOT_FOUND";

  constructor() {
    super("PHOTO_RESERVATION_NOT_FOUND");
    this.name = "PhotoReservationError";
  }
}

interface Reservation<T> {
  token: string;
  previewId: string;
  value: T;
  expiresAtMs: number;
  timer: ReturnType<typeof setTimeout>;
}

export interface CreatedReservation<T> {
  reservationToken: string;
  previewId: string;
  expiresAt: string;
  value: T;
}

/** Runtime-only reservation index. Tokens never enter URLs or persistence. */
export class PhotoReservationStore<T extends { cleanup(): void }> {
  private readonly byToken = new Map<string, Reservation<T>>();
  private readonly tokenByPreview = new Map<string, string>();

  constructor(
    private readonly ttlMs = DEFAULT_PHOTO_RESERVATION_TTL_MS,
    private readonly now = () => Date.now(),
  ) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0)
      throw new Error("INVALID_PHOTO_RESERVATION_TTL");
  }

  create(value: T): CreatedReservation<T> {
    this.sweep();
    const token = randomBytes(32).toString("base64url");
    const previewId = randomUUID();
    const expiresAtMs = this.now() + this.ttlMs;
    const timer = setTimeout(() => this.expire(token), this.ttlMs);
    timer.unref();
    const reservation = { token, previewId, value, expiresAtMs, timer };
    this.byToken.set(token, reservation);
    this.tokenByPreview.set(previewId, token);
    return {
      reservationToken: token,
      previewId,
      expiresAt: new Date(expiresAtMs).toISOString(),
      value,
    };
  }

  require(token: string): T {
    this.sweep();
    return this.requireReservation(token).value;
  }

  preview(previewId: string): T {
    this.sweep();
    const token = this.tokenByPreview.get(previewId);
    if (!token) throw new PhotoReservationError();
    return this.requireReservation(token).value;
  }

  releaseWithoutCleanup(token: string): T {
    this.sweep();
    const reservation = this.requireReservation(token);
    this.unlink(reservation);
    return reservation.value;
  }

  cancel(token: string): void {
    this.sweep();
    const reservation = this.requireReservation(token);
    this.unlink(reservation);
    reservation.value.cleanup();
  }

  close(): void {
    for (const reservation of this.byToken.values()) {
      clearTimeout(reservation.timer);
      reservation.value.cleanup();
    }
    this.byToken.clear();
    this.tokenByPreview.clear();
  }

  get size(): number {
    this.sweep();
    return this.byToken.size;
  }

  private requireReservation(token: string): Reservation<T> {
    const reservation = this.byToken.get(token);
    if (!reservation) throw new PhotoReservationError();
    return reservation;
  }

  private sweep(): void {
    const now = this.now();
    for (const reservation of this.byToken.values()) {
      if (reservation.expiresAtMs <= now) this.expire(reservation.token);
    }
  }

  private expire(token: string): void {
    const reservation = this.byToken.get(token);
    if (!reservation) return;
    this.unlink(reservation);
    reservation.value.cleanup();
  }

  private unlink(reservation: Reservation<T>): void {
    clearTimeout(reservation.timer);
    this.byToken.delete(reservation.token);
    this.tokenByPreview.delete(reservation.previewId);
  }
}
