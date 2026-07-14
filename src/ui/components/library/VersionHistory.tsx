import { useState } from "react";

import type { ApiClient } from "../../api";
import type {
  CharacterProfile,
  CharacterVersion,
  LibraryCharacter,
  LibraryLook,
  LookVersion,
} from "../../types";
import { InlineNotice } from "./LibraryPrimitives";
import { formatLibraryDate, libraryError } from "./library-utils";

export function CharacterHistory(props: {
  client: ApiClient;
  character: LibraryCharacter;
  onRevert: (profile: CharacterProfile) => Promise<void>;
}) {
  const history = useVersionHistory(
    () => props.client.characterHistory(props.character.id),
    (version: CharacterVersion) => props.onRevert(version.profile),
  );
  return (
    <section className="version-history" aria-label="سجل نسخ الشخصية">
      <button
        className="button button--quiet"
        type="button"
        onClick={() => void history.toggle()}
        aria-expanded={history.versions !== null}
      >
        {history.versions
          ? "إغلاق سجل النسخ"
          : `عرض سجل النسخ (${props.character.versionCount})`}
      </button>
      {history.error ? (
        <InlineNotice tone="error">{history.error}</InlineNotice>
      ) : null}
      {history.versions ? (
        <CharacterVersionList
          versions={history.versions}
          currentId={props.character.currentVersionId}
          revertingId={history.revertingId}
          onRevert={history.revert}
        />
      ) : null}
    </section>
  );
}

function CharacterVersionList(props: {
  versions: CharacterVersion[];
  currentId: string;
  revertingId: string;
  onRevert: (version: CharacterVersion) => Promise<void>;
}) {
  return (
    <ol className="version-list">
      {props.versions.map((version) => (
        <li key={version.id}>
          <div>
            <strong title={version.profile.name}>{version.profile.name}</strong>
            <time dateTime={version.createdAt}>
              {formatLibraryDate(version.createdAt)}
            </time>
          </div>
          {version.id === props.currentId ? (
            <span className="plain-badge">النسخة الحالية</span>
          ) : (
            <button
              className="button button--secondary"
              type="button"
              disabled={props.revertingId !== ""}
              onClick={() => void props.onRevert(version)}
            >
              استعادة كنسخة جديدة
            </button>
          )}
        </li>
      ))}
    </ol>
  );
}

export function LookHistory(props: {
  client: ApiClient;
  look: LibraryLook;
  onRevert: (version: LookVersion) => Promise<void>;
}) {
  const history = useVersionHistory(
    () => props.client.lookHistory(props.look.id),
    props.onRevert,
  );
  return (
    <div className="version-history">
      <button
        className="button button--quiet"
        type="button"
        onClick={() => void history.toggle()}
        aria-expanded={history.versions !== null}
      >
        {history.versions
          ? "إغلاق سجل المظهر"
          : `سجل المظهر (${props.look.versionCount})`}
      </button>
      {history.error ? (
        <InlineNotice tone="error">{history.error}</InlineNotice>
      ) : null}
      {history.versions ? (
        <LookVersionList
          versions={history.versions}
          currentId={props.look.currentVersionId}
          revertingId={history.revertingId}
          onRevert={history.revert}
        />
      ) : null}
    </div>
  );
}

function LookVersionList(props: {
  versions: LookVersion[];
  currentId: string;
  revertingId: string;
  onRevert: (version: LookVersion) => Promise<void>;
}) {
  return (
    <ol className="version-list">
      {props.versions.map((version) => (
        <li key={version.id}>
          <div>
            <strong>{version.name}</strong>
            <span>{version.clothing || "بلا وصف ملابس"}</span>
            <time dateTime={version.createdAt}>
              {formatLibraryDate(version.createdAt)}
            </time>
          </div>
          {version.id === props.currentId ? (
            <span className="plain-badge">الحالي</span>
          ) : (
            <button
              className="button button--secondary"
              type="button"
              disabled={props.revertingId !== ""}
              onClick={() => void props.onRevert(version)}
            >
              استعادة كنسخة جديدة
            </button>
          )}
        </li>
      ))}
    </ol>
  );
}

function useVersionHistory<T extends { id: string }>(
  load: () => Promise<T[]>,
  apply: (version: T) => Promise<void>,
) {
  const [versions, setVersions] = useState<T[] | null>(null);
  const [error, setError] = useState("");
  const [revertingId, setRevertingId] = useState("");
  async function toggle() {
    if (versions) return setVersions(null);
    try {
      setError("");
      setVersions(await load());
    } catch (reason) {
      setError(libraryError(reason));
    }
  }
  async function revert(version: T) {
    setRevertingId(version.id);
    setError("");
    try {
      await apply(version);
      setVersions(null);
    } catch (reason) {
      setError(libraryError(reason));
    } finally {
      setRevertingId("");
    }
  }
  return { versions, error, revertingId, toggle, revert };
}
