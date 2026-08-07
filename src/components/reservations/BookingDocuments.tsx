"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/shared/Icon";

// ============================================================
// מסמכים להזמנה — the documents block both booking MDs order (הקמת הזמנה
// §"שלב 4 — מסמכים" ש'28-33; עריכת הזמנה §3.4 ש'49-53): a drag&drop /
// click-to-pick zone (JPG/PNG/PDF only), a row per document — type glyph
// (PDF=danger, image=brand), base name hugging the right WITHOUT its
// extension, size, and exactly three adjacent plain icons (pencil = inline
// rename that preserves the extension, eye = view, trash = remove) — plus an
// internal view-only modal (no download affordance).
//
// GRAPHIC SHELL ONLY: rows live in local component state for the lifetime of
// the panel; nothing is uploaded, fetched or persisted.
// TODO(wire-up): booking_documents storage + loading (the table does not
// exist yet) — save picked files on the reservation and list stored ones.
// ============================================================

type LocalDoc = {
  id: string;
  /** base name (editable inline); the extension is kept behind the scenes */
  base: string;
  ext: string;
  size: number;
  kind: "pdf" | "image";
  /** client-side object URL for the view-only modal — never sent anywhere */
  url: string;
};

const ACCEPT = ".jpg,.jpeg,.png,.pdf,image/jpeg,image/png,application/pdf";

function splitName(name: string): { base: string; ext: string } {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return { base: name, ext: "" };
  return { base: name.slice(0, dot), ext: name.slice(dot) };
}

function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function BookingDocuments() {
  const [docs, setDocs] = useState<LocalDoc[]>([]);
  const [drag, setDrag] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [viewId, setViewId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const docsRef = useRef<LocalDoc[]>([]);
  docsRef.current = docs;

  // object URLs are client memory — release them when the block unmounts
  useEffect(() => {
    return () => {
      for (const d of docsRef.current) URL.revokeObjectURL(d.url);
    };
  }, []);

  const addFiles = (files: FileList | null) => {
    if (!files) return;
    const next: LocalDoc[] = [];
    for (const f of Array.from(files)) {
      const isPdf = f.type === "application/pdf";
      const isImg = f.type === "image/jpeg" || f.type === "image/png";
      if (!isPdf && !isImg) continue; // JPG/PNG/PDF only (MD)
      const { base, ext } = splitName(f.name);
      next.push({
        id: Math.random().toString(36).slice(2, 10),
        base,
        ext,
        size: f.size,
        kind: isPdf ? "pdf" : "image",
        url: URL.createObjectURL(f),
      });
    }
    if (next.length) setDocs((all) => [...all, ...next]);
  };

  const remove = (id: string) => {
    const doc = docs.find((d) => d.id === id);
    if (doc) URL.revokeObjectURL(doc.url);
    setDocs((all) => all.filter((d) => d.id !== id));
    if (viewId === id) setViewId(null);
  };

  const rename = (id: string, base: string) => {
    const clean = base.trim();
    // the rename edits the BASE name only — the extension cannot change (MD)
    if (clean) setDocs((all) => all.map((d) => (d.id === id ? { ...d, base: clean } : d)));
    setRenamingId(null);
  };

  const viewed = viewId ? docs.find((d) => d.id === viewId) : null;

  return (
    <div>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        multiple
        className="hidden"
        onChange={(e) => {
          addFiles(e.target.files);
          e.target.value = "";
        }}
      />
      <div
        role="button"
        tabIndex={0}
        className={`bw-drop${drag ? " drag" : ""}`}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          addFiles(e.dataTransfer.files);
        }}
      >
        <Icon name="upload" size={36} />
        <span className="bw-drop-main">גררו לכאן מסמכים או לחצו לבחירה</span>
        {/* the demo's sub-line, with its saved-with-the-reservation promise
            swapped for the SHELL truth (no persistence yet) — the demo text
            returns at wire-up */}
        <span className="bw-drop-sub">
          תמונות (JPG/PNG) או PDF · שמירת המסמכים על ההזמנה תחובר בהמשך — קבצים
          שנבחרו מוצגים בינתיים בחלון זה בלבד
        </span>
      </div>

      {docs.length > 0 && (
        <ul className="bw-doc-list">
          {docs.map((d) => (
            <li key={d.id} className="bw-doc">
              <span className={`bw-doc-ic ${d.kind === "pdf" ? "pdf" : "img"}`}>
                <Icon name={d.kind === "pdf" ? "pdf" : "image"} size={26} />
              </span>
              {/* the demo stacks the row text: bold name over a muted sub-line
                  (size only — the demo's "· שמור בהזמנה" is a persistence
                  promise the shell must not make; back at wire-up) */}
              <div className="bw-doc-txt">
                {renamingId === d.id ? (
                  <input
                    className="bw-doc-name-input"
                    autoFocus
                    defaultValue={d.base}
                    aria-label="שינוי שם קובץ"
                    onBlur={(e) => rename(d.id, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        rename(d.id, e.currentTarget.value);
                      } else if (e.key === "Escape") {
                        setRenamingId(null);
                      }
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    className="bw-doc-name"
                    title="צפייה במסמך"
                    onClick={() => setViewId(d.id)}
                  >
                    {d.base}
                  </button>
                )}
                <span className="bw-doc-size ltr-num">{fmtSize(d.size)}</span>
              </div>
              <span className="bw-doc-acts">
                <button
                  type="button"
                  className="bw-doc-act"
                  title="שינוי שם"
                  aria-label="שינוי שם"
                  onClick={() => setRenamingId(d.id)}
                >
                  <Icon name="edit" size={20} />
                </button>
                <button
                  type="button"
                  className="bw-doc-act"
                  title="צפייה"
                  aria-label="צפייה"
                  onClick={() => setViewId(d.id)}
                >
                  <Icon name="eye" size={20} />
                </button>
                <button
                  type="button"
                  className="bw-doc-act del"
                  title="הסרה"
                  aria-label="הסרה"
                  onClick={() => remove(d.id)}
                >
                  <Icon name="trash" size={20} />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      {/* internal viewer — a centered view-only modal (the MD's explicit
          order for this block); no download affordance is rendered */}
      {viewed && (
        <div className="bw-docv" role="dialog" aria-label={`צפייה: ${viewed.base}`}>
          <div className="bw-docv-box">
            <div className="bw-docv-hd">
              <Icon name={viewed.kind === "pdf" ? "pdf" : "image"} size={20} />
              <span className="min-w-0 flex-1 truncate">{viewed.base}</span>
              <button
                type="button"
                className="dw-close"
                title="סגירה"
                onClick={() => setViewId(null)}
              >
                <Icon name="close" size={20} label="סגירה" />
              </button>
            </div>
            <div className="bw-docv-bd">
              {viewed.kind === "image" ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={viewed.url} alt={viewed.base} />
              ) : (
                <iframe src={`${viewed.url}#toolbar=0`} title={viewed.base} />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
