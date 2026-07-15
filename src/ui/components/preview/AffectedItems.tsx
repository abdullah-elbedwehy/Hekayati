import type { LayoutAffectedItems } from "../../layout-types";
import { shortId } from "./format";

export function AffectedItems({
  affected,
}: {
  affected: LayoutAffectedItems[];
}) {
  if (!affected.length) return null;
  return (
    <section className="preview-panel" aria-labelledby="affected-title">
      <div className="preview-section-heading">
        <div>
          <p className="eyebrow">أثر التغيير المجمد</p>
          <h2 id="affected-title">العناصر المتأثرة</h2>
        </div>
      </div>
      {affected.map((group) => (
        <div className="preview-affected-group" key={group.event.id}>
          <strong>{group.event.matrixRow}</strong>
          <bdi>{shortId(group.event.id)}</bdi>
          <ul>
            {group.affected.map((item) => (
              <li key={`${item.kind}:${item.id}`}>
                {item.kind} — {item.effect} — <bdi>{shortId(item.id)}</bdi>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
