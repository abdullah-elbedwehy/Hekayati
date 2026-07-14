import { describe, expect, it, vi } from "vitest";

import {
  PhotoReservationError,
  PhotoReservationStore,
} from "../../src/server/photo-intake/reservations.js";

describe("runtime-only photo reservations", () => {
  it("uses distinct opaque commit tokens and token-free preview IDs", () => {
    const resource = { cleanup: vi.fn() };
    const reservations = new PhotoReservationStore(60_000);
    const created = reservations.create(resource);

    expect(created.reservationToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(created.previewId).not.toContain(created.reservationToken);
    expect(reservations.require(created.reservationToken)).toBe(resource);
    expect(reservations.preview(created.previewId)).toBe(resource);
    expect(resource.cleanup).not.toHaveBeenCalled();
    reservations.close();
    expect(resource.cleanup).toHaveBeenCalledOnce();
  });

  it("expires and zeroizes abandoned resources without persistence", () => {
    let now = 1_000;
    const resource = { cleanup: vi.fn() };
    const reservations = new PhotoReservationStore(50, () => now);
    const created = reservations.create(resource);
    now = 1_051;

    expect(() => reservations.require(created.reservationToken)).toThrow(
      PhotoReservationError,
    );
    expect(resource.cleanup).toHaveBeenCalledOnce();
    expect(reservations.size).toBe(0);
  });

  it("transfers ownership on commit but cleans explicitly cancelled work", () => {
    const committed = { cleanup: vi.fn() };
    const cancelled = { cleanup: vi.fn() };
    const reservations = new PhotoReservationStore(60_000);
    const first = reservations.create(committed);
    const second = reservations.create(cancelled);

    expect(reservations.releaseWithoutCleanup(first.reservationToken)).toBe(
      committed,
    );
    reservations.cancel(second.reservationToken);
    expect(committed.cleanup).not.toHaveBeenCalled();
    expect(cancelled.cleanup).toHaveBeenCalledOnce();
    expect(() => reservations.preview(first.previewId)).toThrow(
      "PHOTO_RESERVATION_NOT_FOUND",
    );
  });
});
