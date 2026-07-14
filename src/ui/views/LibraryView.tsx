import { useCallback, useEffect, useState } from "react";

import type {
  ApiClient,
  CharacterInput,
  CharacterVersionInput,
  CustomerInput,
  FamilyInput,
  LookInput,
  LookVersionInput,
} from "../api";
import { ApiError } from "../api";
import { CustomerRail } from "../components/library/CustomerRail";
import { CustomerWorkspace } from "../components/library/CustomerWorkspace";
import { FamilyWorkspace } from "../components/library/FamilyWorkspace";
import {
  DeferredFeatureNote,
  InlineNotice,
} from "../components/library/LibraryPrimitives";
import { libraryError } from "../components/library/library-utils";
import type {
  ConsentRecord,
  LibraryCharacter,
  LibraryLook,
  LibrarySnapshot,
} from "../types";

export function LibraryView({ client }: { client: ApiClient }) {
  const state = useLibraryState(client);
  if (state.loading) return <LibraryLoading />;
  if (!state.snapshot)
    return <LibraryFailure message={state.error} stale={state.stale} />;
  return (
    <main className="view view--library" id="main-content">
      <LibraryHeader onRefresh={state.reload} />
      {state.error ? (
        <InlineNotice tone="error">{state.error}</InlineNotice>
      ) : null}
      <div className="library-shell">
        <CustomerRail
          customers={state.snapshot.customers}
          selectedId={state.customer?.id}
          onSelect={state.selectCustomer}
          onCreate={state.createCustomer}
        />
        <LibraryContent state={state} client={client} />
      </div>
    </main>
  );
}

function LibraryHeader({ onRefresh }: { onRefresh: () => Promise<void> }) {
  return (
    <header className="view-header view-header--with-action library-view-header">
      <div>
        <p className="eyebrow">تعمل بلا مزوّد ذكاء اصطناعي</p>
        <h1>مكتبة العائلات والشخصيات</h1>
        <p>
          سجلات محلية بإصدارات ثابتة، وحدود عائلية واضحة، وصور مشتقة للعرض فقط.
        </p>
      </div>
      <button
        className="button button--secondary"
        type="button"
        onClick={() => void onRefresh()}
      >
        تحديث المكتبة
      </button>
    </header>
  );
}

function LibraryContent({
  state,
  client,
}: {
  state: LibraryState;
  client: ApiClient;
}) {
  if (!state.customer)
    return (
      <section className="library-empty">
        <div className="empty-mark" aria-hidden="true">
          ح
        </div>
        <h2>أضف أول عميل</h2>
        <p>
          لن يُنشأ أي سجل عائلة أو موافقة تلقائيًا. ابدأ من النموذج المجاور.
        </p>
      </section>
    );
  return (
    <div className="library-content">
      <CustomerArea state={state} />
      <FamilyArea state={state} client={client} />
      <DeferredFeatureNote />
    </div>
  );
}

function CustomerArea({ state }: { state: LibraryState }) {
  if (!state.customer) return null;
  return (
    <CustomerWorkspace
      key={state.customer.id}
      customer={state.customer}
      families={state.families}
      selectedFamilyId={state.family?.id}
      onSelectFamily={state.selectFamily}
      onUpdate={state.updateCustomer}
      onVisibility={state.customerVisibility}
      onConsent={state.recordConsent}
      onCreateFamily={state.createFamily}
    />
  );
}

function FamilyArea({
  state,
  client,
}: {
  state: LibraryState;
  client: ApiClient;
}) {
  if (!state.family) return <NoFamily />;
  return (
    <FamilyWorkspace
      key={state.family.id}
      client={client}
      family={state.family}
      characters={state.characters}
      looks={state.looks}
      referencePhotos={state.referencePhotos}
      selectedCharacterId={state.character?.id}
      onSelectCharacter={state.selectCharacter}
      onFamilyVisibility={state.familyVisibility}
      onUpdateFamily={state.updateFamily}
      onCreateCharacter={state.createCharacter}
      onUpdateCharacter={state.updateCharacter}
      onCharacterVisibility={state.characterVisibility}
      onCreateLook={state.createLook}
      onUpdateLook={state.updateLook}
      onLookVisibility={state.lookVisibility}
      onRefresh={state.reload}
    />
  );
}

function NoFamily() {
  return (
    <section className="family-empty">
      <h2>أنشئ عائلة لهذا العميل</h2>
      <p>
        العائلة هي الحد الذي يمنع خلط الشخصيات بين العملاء. بعد إنشائها، أضف
        الطفل المحور أولًا.
      </p>
    </section>
  );
}

interface Selection {
  customerId?: string;
  familyId?: string;
  characterId?: string;
}

function useLibraryState(client: ApiClient) {
  const [snapshot, setSnapshot] = useState<LibrarySnapshot | null>(null);
  const [selection, setSelection] = useState<Selection>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);
  const reload = useCallback(async () => {
    try {
      setSnapshot(await client.library());
      setError("");
    } catch (reason) {
      setStale(
        reason instanceof ApiError && reason.category === "stale_session",
      );
      setError(libraryError(reason));
    } finally {
      setLoading(false);
    }
  }, [client]);
  useInitialLibraryLoad(client, setSnapshot, setLoading, setError, setStale);
  const selected = deriveSelection(snapshot, selection);
  const actions = buildActions(
    client,
    reload,
    selection,
    setSelection,
    selected,
  );
  return {
    snapshot,
    selection,
    loading,
    error,
    stale,
    reload,
    ...selected,
    ...actions,
  };
}

function useInitialLibraryLoad(
  client: ApiClient,
  setSnapshot: (value: LibrarySnapshot) => void,
  setLoading: (value: boolean) => void,
  setError: (value: string) => void,
  setStale: (value: boolean) => void,
) {
  useEffect(() => {
    let active = true;
    void client
      .library()
      .then((value) => {
        if (active) setSnapshot(value);
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setStale(
          reason instanceof ApiError && reason.category === "stale_session",
        );
        setError(libraryError(reason));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [client, setError, setLoading, setSnapshot, setStale]);
}

function deriveSelection(
  snapshot: LibrarySnapshot | null,
  selection: Selection,
) {
  const customer =
    snapshot?.customers.find((item) => item.id === selection.customerId) ??
    snapshot?.customers.find((item) => item.status === "active") ??
    snapshot?.customers[0];
  const families =
    snapshot?.families.filter((item) => item.customerId === customer?.id) ?? [];
  const family =
    families.find((item) => item.id === selection.familyId) ??
    families.find((item) => item.status === "active") ??
    families[0];
  const characters =
    snapshot?.characters.filter((item) => item.familyId === family?.id) ?? [];
  const character =
    characters.find((item) => item.id === selection.characterId) ??
    characters.find((item) => item.status === "active") ??
    characters[0];
  return {
    customer,
    families,
    family,
    characters,
    character,
    looks: snapshot?.looks ?? [],
    referencePhotos: snapshot?.referencePhotos ?? [],
  };
}

type Reload = () => Promise<void>;
type SetSelection = (
  value: Selection | ((current: Selection) => Selection),
) => void;
type Selected = ReturnType<typeof deriveSelection>;

function buildActions(
  client: ApiClient,
  reload: Reload,
  selection: Selection,
  setSelection: SetSelection,
  selected: Selected,
) {
  return {
    ...buildSelectionActions(selection, setSelection, selected),
    ...buildCustomerActions(client, reload, setSelection, selected),
    ...buildFamilyActions(client, reload, selection, setSelection, selected),
    ...buildCharacterActions(client, reload, selection, setSelection, selected),
    ...buildLookActions(client, reload),
  };
}

function buildSelectionActions(
  selection: Selection,
  setSelection: SetSelection,
  selected: Selected,
) {
  return {
    selectCustomer: (customerId: string) => setSelection({ customerId }),
    selectFamily: (familyId: string) =>
      setSelection({ customerId: selected.customer?.id, familyId }),
    selectCharacter: (characterId: string) =>
      setSelection({ ...selection, characterId }),
  };
}

function buildCustomerActions(
  client: ApiClient,
  reload: Reload,
  setSelection: SetSelection,
  selected: Selected,
) {
  return {
    createCustomer: (input: CustomerInput) =>
      focus(
        client.createCustomer(input),
        (customerId) => ({ customerId }),
        setSelection,
        reload,
      ),
    updateCustomer: async (input: CustomerInput) => {
      await client.updateCustomer(required(selected.customer?.id), input);
      await reload();
    },
    customerVisibility: async (action: "archive" | "restore") => {
      await client.setCustomerVisibility(
        required(selected.customer?.id),
        action,
      );
      await reload();
    },
    recordConsent: async (consent: ConsentRecord | null) => {
      await client.recordConsent(required(selected.customer?.id), consent);
      await reload();
    },
  };
}

function buildFamilyActions(
  client: ApiClient,
  reload: Reload,
  selection: Selection,
  setSelection: SetSelection,
  selected: Selected,
) {
  return {
    createFamily: (input: FamilyInput) =>
      focus(
        client.createFamily(required(selected.customer?.id), input),
        (familyId) => ({ customerId: selected.customer?.id, familyId }),
        setSelection,
        reload,
      ),
    familyVisibility: async (action: "archive" | "restore") => {
      await client.setFamilyVisibility(required(selected.family?.id), action);
      await reload();
    },
    updateFamily: async (input: FamilyInput) => {
      await client.updateFamily(required(selected.family?.id), input);
      await reload();
    },
  };
}

function buildCharacterActions(
  client: ApiClient,
  reload: Reload,
  selection: Selection,
  setSelection: SetSelection,
  selected: Selected,
) {
  return {
    createCharacter: (input: CharacterInput) =>
      focus(
        client.createCharacter(required(selected.family?.id), input),
        (characterId) => ({ ...selection, characterId }),
        setSelection,
        reload,
      ),
    updateCharacter: async (
      character: LibraryCharacter,
      input: CharacterVersionInput,
    ) => {
      await client.updateCharacter(character.id, input);
      await reload();
    },
    characterVisibility: async (
      character: LibraryCharacter,
      action: "archive" | "restore",
    ) => {
      await client.setCharacterVisibility(character.id, action);
      await reload();
    },
  };
}

function buildLookActions(client: ApiClient, reload: Reload) {
  return {
    createLook: async (character: LibraryCharacter, input: LookInput) => {
      await client.createLook(character.id, input);
      await reload();
    },
    updateLook: async (look: LibraryLook, input: LookVersionInput) => {
      await client.updateLook(look.id, input);
      await reload();
    },
    lookVisibility: async (
      look: LibraryLook,
      action: "archive" | "restore",
    ) => {
      await client.setLookVisibility(look.id, action);
      await reload();
    },
  };
}

async function focus(
  task: Promise<{ id: string }>,
  next: (id: string) => Selection,
  setSelection: SetSelection,
  reload: Reload,
) {
  const result = await task;
  setSelection(next(result.id));
  await reload();
}

type LibraryState = ReturnType<typeof useLibraryState>;

function required(value?: string): string {
  if (!value) throw new Error("MISSING_LIBRARY_SELECTION");
  return value;
}

function LibraryLoading() {
  return (
    <main className="view library-loading" id="main-content" aria-busy="true">
      <div className="skeleton-line" />
      <div className="skeleton-library">
        <div />
        <div />
      </div>
    </main>
  );
}

function LibraryFailure({
  message,
  stale,
}: {
  message: string;
  stale: boolean;
}) {
  return (
    <main className="view library-failure" id="main-content">
      <div className="error-mark" aria-hidden="true">
        !
      </div>
      <h1>{stale ? "انتهت جلسة التبويب المحلية" : "تعذّر فتح المكتبة"}</h1>
      <p>
        {stale
          ? "أُعيد تشغيل التطبيق. أعد تحميل الصفحة للحصول على رمز الطلب الآمن الجديد."
          : message}
      </p>
      <button
        className="button button--primary"
        onClick={() => window.location.reload()}
      >
        إعادة التحميل
      </button>
    </main>
  );
}
