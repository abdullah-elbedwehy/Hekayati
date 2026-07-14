import { ulid } from "ulid";

import type { DocumentStore } from "../repository/document-store.js";
import { fail } from "./errors.js";
import { LibraryRepositories } from "./repositories.js";
import {
  consentRecordSchema,
  entityIdSchema,
  familySchema,
  type ChangeEvent,
  type Character,
  type ConsentRecord,
  type Customer,
  type Family,
  type Relationship,
} from "./schemas.js";
import type {
  ConsentDecision,
  FamilyScope,
  LibraryServiceOptions,
  PhotoConsentUse,
} from "./types.js";

export class LibraryCore {
  protected readonly repositories: LibraryRepositories;
  protected readonly now: () => string;
  protected readonly idFactory: () => string;

  constructor(
    protected readonly store: DocumentStore,
    options: LibraryServiceOptions = {},
  ) {
    this.repositories = new LibraryRepositories(store);
    this.now = options.now ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? ulid;
  }

  createCustomer(input: {
    id?: string;
    name: string;
    whatsapp: string;
    notes: string;
  }): Customer {
    const at = this.now();
    return this.repositories.customers.insert(
      {
        id: this.newId(input.id),
        schemaVersion: 1,
        createdAt: at,
        updatedAt: at,
        name: input.name,
        whatsapp: input.whatsapp,
        notes: input.notes,
        consent: null,
        status: "active",
      },
      "DUPLICATE_ENTITY_ID",
    );
  }

  getCustomer(customerId: string): Customer {
    this.parseId(customerId);
    return (
      this.repositories.customers.get(customerId) ?? fail("CUSTOMER_NOT_FOUND")
    );
  }

  listCustomers(options: { includeArchived?: boolean } = {}): Customer[] {
    return this.repositories.customers
      .list()
      .filter(
        (customer) => options.includeArchived || customer.status === "active",
      );
  }

  updateCustomer(
    customerId: string,
    patch: Partial<Pick<Customer, "name" | "whatsapp" | "notes">>,
  ): Customer {
    const current = this.getCustomer(customerId);
    return this.repositories.customers.update({
      ...current,
      ...patch,
      updatedAt: this.now(),
    });
  }

  recordConsent(customerId: string, consent: ConsentRecord): Customer {
    return this.updateCustomerConsent(
      customerId,
      consentRecordSchema.parse(consent),
    );
  }

  clearConsent(customerId: string): Customer {
    return this.updateCustomerConsent(customerId, null);
  }

  consentDecision(customerId: string, use: PhotoConsentUse): ConsentDecision {
    const consent = this.getCustomer(customerId).consent;
    if (use === "description_only" || use === "description_derived_sheet")
      return { allowed: true, reason: "PHOTO_NOT_REQUIRED" };
    if (!consent) return { allowed: false, code: "PHOTO_CONSENT_NOT_RECORDED" };
    return consent.granted
      ? { allowed: true, reason: "CONSENT_GRANTED" }
      : { allowed: false, code: "PHOTO_CONSENT_NOT_GRANTED" };
  }

  assertPhotoConsent(customerId: string, use: PhotoConsentUse): void {
    const decision = this.consentDecision(customerId, use);
    if (!decision.allowed) fail(decision.code);
  }

  archiveCustomer(customerId: string): Customer {
    return this.setCustomerStatus(customerId, "archived");
  }

  restoreCustomer(customerId: string): Customer {
    return this.setCustomerStatus(customerId, "active");
  }

  createFamily(input: {
    id?: string;
    customerId: string;
    name: string;
  }): Family {
    const customer = this.getCustomer(input.customerId);
    this.assertActive(customer.status);
    const at = this.now();
    const family = familySchema.parse({
      id: this.newId(input.id),
      schemaVersion: 1,
      createdAt: at,
      updatedAt: at,
      customerId: input.customerId,
      name: input.name,
      anchorCharacterId: null,
      status: "active",
    });
    return this.repositories.families.insert(family, "DUPLICATE_ENTITY_ID");
  }

  getFamily(scope: FamilyScope): Family {
    return this.scopedFamily(scope).family;
  }

  scopeForFamilyId(familyId: string): FamilyScope {
    this.parseId(familyId);
    const family =
      this.repositories.families.get(familyId) ?? fail("FAMILY_NOT_FOUND");
    this.getCustomer(family.customerId);
    return { customerId: family.customerId, familyId: family.id };
  }

  listFamilies(
    customerId: string,
    options: { includeArchived?: boolean } = {},
  ): Family[] {
    const customer = this.getCustomer(customerId);
    if (!options.includeArchived && customer.status === "archived") return [];
    return this.repositories.families
      .queryByField("customerId", customerId)
      .filter(
        (family) => options.includeArchived || family.status === "active",
      );
  }

  updateFamily(scope: FamilyScope, patch: { name: string }): Family {
    const { family } = this.scopedFamily(scope);
    return this.repositories.families.update({
      ...family,
      name: patch.name,
      updatedAt: this.now(),
    });
  }

  archiveFamily(scope: FamilyScope): Family {
    return this.setFamilyStatus(scope, "archived");
  }

  restoreFamily(scope: FamilyScope): Family {
    return this.setFamilyStatus(scope, "active");
  }

  protected scopedFamily(scope: FamilyScope): {
    customer: Customer;
    family: Family;
  } {
    this.parseId(scope.customerId);
    this.parseId(scope.familyId);
    const customer = this.getCustomer(scope.customerId);
    const family = this.repositories.families.get(scope.familyId);
    if (!family) fail("FAMILY_NOT_FOUND");
    if (family.customerId !== scope.customerId) fail("FAMILY_SCOPE_MISMATCH");
    return { customer, family };
  }

  protected assertNewMemberAnchor(
    family: Family,
    relationship: Relationship,
  ): void {
    if (!family.anchorCharacterId) {
      if (relationship.type !== "main_child") fail("FAMILY_ANCHOR_REQUIRED");
      return;
    }
    this.assertFamilyAnchorAvailable(family);
    if (relationship.type === "main_child") fail("FAMILY_ANCHOR_IMMUTABLE");
  }

  protected assertFamilyAnchorAvailable(family: Family): Character {
    if (!family.anchorCharacterId) fail("FAMILY_ANCHOR_REQUIRED");
    const anchor = this.repositories.characters.get(family.anchorCharacterId);
    if (!anchor) fail("FAMILY_ANCHOR_REQUIRED");
    if (anchor.status === "archived") fail("FAMILY_ANCHOR_ARCHIVED");
    return anchor;
  }

  protected familyIsSelectable(customer: Customer, family: Family): boolean {
    if (customer.status === "archived" || family.status === "archived")
      return false;
    if (!family.anchorCharacterId) return false;
    return (
      this.repositories.characters.get(family.anchorCharacterId)?.status ===
      "active"
    );
  }

  protected appendVisibilityEvent(entityId: string): ChangeEvent {
    const at = this.now();
    return this.repositories.changeEvents.insert(
      {
        id: this.newId(),
        schemaVersion: 1,
        createdAt: at,
        updatedAt: at,
        entity: "library_visibility",
        entityId,
        fromVersionId: null,
        toVersionId: null,
        changeType: "archive_restore",
        matrixRow: "IM-21",
        changedFields: ["status"],
        correlationId: this.newId(),
        occurredAt: at,
      },
      "DUPLICATE_ENTITY_ID",
    );
  }

  protected assertActive(...statuses: Array<"active" | "archived">): void {
    if (statuses.some((status) => status === "archived"))
      fail("ENTITY_ARCHIVED");
  }

  protected newId(value?: string): string {
    return entityIdSchema.parse(value ?? this.idFactory());
  }

  protected parseId(value: string): void {
    entityIdSchema.parse(value);
  }

  private updateCustomerConsent(
    customerId: string,
    consent: ConsentRecord | null,
  ): Customer {
    const current = this.getCustomer(customerId);
    return this.repositories.customers.update({
      ...current,
      consent,
      updatedAt: this.now(),
    });
  }

  private setCustomerStatus(
    customerId: string,
    status: Customer["status"],
  ): Customer {
    return this.store.transaction(() => {
      const current = this.getCustomer(customerId);
      if (current.status === status) return current;
      const updated = this.repositories.customers.update({
        ...current,
        status,
        updatedAt: this.now(),
      });
      this.appendVisibilityEvent(customerId);
      return updated;
    });
  }

  private setFamilyStatus(
    scope: FamilyScope,
    status: Family["status"],
  ): Family {
    return this.store.transaction(() => {
      const { family } = this.scopedFamily(scope);
      if (family.status === status) return family;
      const updated = this.repositories.families.update({
        ...family,
        status,
        updatedAt: this.now(),
      });
      this.appendVisibilityEvent(family.id);
      return updated;
    });
  }
}
